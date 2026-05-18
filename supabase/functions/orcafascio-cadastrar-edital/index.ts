// =============================================================================
// Edge Function: orcafascio-cadastrar-edital (Plano A híbrido)
// =============================================================================
// A partir das `composicoes_extraidas` de uma licitação:
//   1. Cria um grupo (pasta) no MyBase do Orçafascio
//   2. Pra cada composição PRÓPRIA do edital, cria a composição no MyBase
//      e adiciona seus itens (sub-insumos) referenciando códigos
//      SINAPI/SEINFRA/ORSE/etc. que já existem na base do Orçafascio
//   3. Atualiza composicoes_extraidas.orcafascio_composition_id
//   4. Transição da licitação: criando_composicoes_edital → fase1_concluida
//
// Pré-requisitos pra esta função funcionar end-to-end:
//   - Credencial Orçafascio cadastrada (provider='orcafascio', metadata.auth_type='api')
//     com o secret_token no Vault
//   - Licitação com status em {aguardando_revisao_humana, criando_composicoes_edital,
//     fase1_concluida (idempotent retry)}
//   - composicoes_extraidas populadas (via Edge Function extracao-edital)
//
// LIMITAÇÃO confirmada pela documentação oficial do Orçafascio:
//   Não existe endpoint público pra criar o ORÇAMENTO em si (apenas /bud/budgets/list
//   pra listar). O orçamentista finaliza no painel do Orçafascio criando um novo
//   orçamento que aponte pra pasta gerada por esta função e importando as
//   composições já cadastradas.
//
// Body (JSON):
//   {
//     "licitacao_id": "uuid",        // obrigatório
//     "credential_id": "uuid",        // obrigatório
//     "force_relog": false,           // opcional
//     "trace_id": "uuid"              // opcional
//   }
//
// Resposta 200:
//   {
//     "ok": true,
//     "grupo_id": "...",
//     "grupo_descricao": "...",
//     "composicoes_criadas": 24,
//     "composicoes_puladas": 1,        // já tinham orcafascio_composition_id
//     "itens_adicionados": 134,
//     "warnings": [...]
//   }
// =============================================================================

import { handleCorsPreflight } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/json.ts';
import {
  getServiceRoleClient,
  HttpError,
  requireAuthenticatedUser,
} from '../_shared/supabase.ts';
import {
  authenticateOrcafascio,
  OrcafascioAuthError,
} from '../_shared/orcafascio.ts';
import {
  addBasesToComposition,
  addItemsToComposition,
  COMPOSITION_TYPES,
  createComposition,
  createGroup,
  createResource,
  deleteResource,
  findCompositionByCode,
  findGroupByDescription,
  findMyBaseResourceByCode,
  fonteToBank,
  OrcafascioApiError,
  pickUF,
  RESOURCE_TYPE,
  ROUNDING_TYPE,
  type CompositionItem,
} from '../_shared/orcafascio-mybase.ts';

interface RequestBody {
  licitacao_id?: string;
  credential_id?: string;
  force_relog?: boolean;
  trace_id?: string;
}

interface ComposicaoExtraida {
  id: string;
  item_codigo: string;
  codigo: string | null;
  fonte: string | null;
  descricao: string;
  unidade: string | null;
  tipo_linha: string;
  orcafascio_composition_id: string | null;
}

interface ComposicaoPropriaItem {
  composicao_extraida_id: string;
  classe: string;
  codigo: string | null;
  fonte: string;
  descricao: string;
  unidade: string | null;
  coeficiente: number | null;
  preco_unitario: number | null;
}

const ERR_AUTH_TO_HTTP: Record<OrcafascioAuthError['code'], number> = {
  credential_not_found: 404,
  credential_inactive: 403,
  credential_wrong_provider: 400,
  credential_no_email: 422,
  vault_unreadable: 500,
  orcafascio_rejected: 422,
  orcafascio_unreachable: 502,
  orcafascio_unexpected: 502,
};

Deno.serve(async (req: Request) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;

  if (req.method !== 'POST') {
    return errorResponse(405, 'Método não permitido. Use POST.');
  }

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, 'JSON inválido no body.');
  }

  const licitacaoId = body.licitacao_id?.trim();
  const credentialId = body.credential_id?.trim();
  if (!licitacaoId) return errorResponse(400, 'licitacao_id é obrigatório.');
  if (!credentialId) return errorResponse(400, 'credential_id é obrigatório.');

  const traceId = body.trace_id ?? crypto.randomUUID();
  const admin = getServiceRoleClient();
  const warnings: string[] = [];

  try {
    const user = await requireAuthenticatedUser(req);

    // ---- 1) Carrega licitação + composições -----------------------------------
    const { data: licitacao, error: licErr } = await admin
      .from('licitacoes')
      .select('id, titulo, numero_edital, orgao_licitante, municipio, uf, status')
      .eq('id', licitacaoId)
      .maybeSingle();
    if (licErr || !licitacao) {
      return errorResponse(404, 'Licitação não encontrada.', licErr?.message);
    }
    const ALLOWED_STATUS = new Set([
      'aguardando_revisao_humana',
      'criando_composicoes_edital',
      'fase1_concluida', // permite retry idempotente
    ]);
    if (!ALLOWED_STATUS.has(licitacao.status)) {
      return errorResponse(
        409,
        `Licitação está em "${licitacao.status}" — precisa estar em ${[...ALLOWED_STATUS].join(', ')}.`,
      );
    }

    const { data: composicoes, error: compErr } = await admin
      .from('composicoes_extraidas')
      .select('id, item_codigo, codigo, fonte, descricao, unidade, tipo_linha, orcafascio_composition_id')
      .eq('licitacao_id', licitacaoId)
      .eq('fonte', 'PROPRIA')
      .eq('tipo_linha', 'servico');
    if (compErr) {
      return errorResponse(500, 'Falha ao ler composicoes_extraidas.', compErr.message);
    }
    if (!composicoes || composicoes.length === 0) {
      return errorResponse(422, 'Nenhuma composição PRÓPRIA encontrada nesta licitação.');
    }

    // Pega cabecalho da extração pra montar bases (data-base + UF). Sem isso,
    // composições novas usam SINAPI/AC/01-2026 default → códigos do edital
    // (que vivem em outra UF/data) retornam 500 ao serem adicionados.
    const { data: extr } = await admin
      .from('extracoes_ocr')
      .select('json_corrigido, json_extraido')
      .eq('licitacao_id', licitacaoId)
      .in('status', ['sucesso', 'revisada_humano'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const cabecalho = ((extr?.json_corrigido ?? extr?.json_extraido) as
      { cabecalho?: { data_base_descricao?: string; uf?: string; bases_utilizadas?: string[]; com_desoneracao?: boolean } } | null
    )?.cabecalho ?? {};
    // Monta versão default MM/AAAA do data_base_descricao
    // Aceita: "fev/26", "02/2026", "fevereiro/2026", "JANEIRO/2026"
    function parseDataBase(s: string | undefined): string {
      if (!s) {
        const d = new Date();
        return `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
      }
      const meses: Record<string, string> = {
        jan: '01', janeiro: '01',
        fev: '02', fevereiro: '02',
        mar: '03', marco: '03', março: '03',
        abr: '04', abril: '04',
        mai: '05', maio: '05',
        jun: '06', junho: '06',
        jul: '07', julho: '07',
        ago: '08', agosto: '08',
        set: '09', setembro: '09',
        out: '10', outubro: '10',
        nov: '11', novembro: '11',
        dez: '12', dezembro: '12',
      };
      const normalized = s.toLowerCase().trim();
      // Tenta formato "MM/AAAA" direto
      const direct = normalized.match(/(\d{1,2})\s*\/\s*(\d{4}|\d{2})/);
      if (direct) {
        const month = direct[1].padStart(2, '0');
        const year = direct[2].length === 2 ? `20${direct[2]}` : direct[2];
        return `${month}/${year}`;
      }
      // "fev/26" ou "fevereiro/2026"
      const named = normalized.match(/([a-zç]+)\s*\/\s*(\d{4}|\d{2})/);
      if (named && meses[named[1]]) {
        const month = meses[named[1]];
        const year = named[2].length === 2 ? `20${named[2]}` : named[2];
        return `${month}/${year}`;
      }
      // Fallback
      const d = new Date();
      return `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    }
    const dataBaseEdital = parseDataBase(cabecalho.data_base_descricao);
    const ufEdital = (cabecalho.uf ?? licitacao.uf ?? 'SP').toString().toUpperCase().slice(0, 2);
    const basesEdital = Array.isArray(cabecalho.bases_utilizadas)
      ? cabecalho.bases_utilizadas.map((b) => String(b).toUpperCase().trim()).filter((b) => b !== 'PROPRIA')
      : ['SINAPI'];

    // Normaliza nome do banco + UF padrão pros bancos que só existem em
    // um estado. Sem isso, addBases retorna 422 "Local not found"
    // (ORSE só em SE) ou "Base not found" (SICRO → precisa SICRO3).
    interface BankConfig { name: string; local: string }
    const BANK_NORMALIZATION: Record<string, BankConfig | { skipUf: false; renameOnly: string }> = {
      SICRO: { name: 'SICRO3', local: '' },     // local segue ufEdital
      SICRO3: { name: 'SICRO3', local: '' },
      SINAPI: { name: 'SINAPI', local: '' },
      SBC: { name: 'SBC', local: 'BA' },         // SBC fixo em BA
      ORSE: { name: 'ORSE', local: 'SE' },       // ORSE fixo em SE
      SEINFRA: { name: 'SEINFRA', local: 'CE' }, // SEINFRA fixo em CE
      SETOP: { name: 'SETOP', local: 'MG' },
      EMBASA: { name: 'EMBASA', local: 'BA' },
      FDE: { name: 'FDE', local: 'SP' },
      CPOS: { name: 'CPOS', local: 'SP' },
      SUDECAP: { name: 'SUDECAP', local: 'MG' },
      IOPES: { name: 'IOPES', local: 'ES' },
      AGESUL: { name: 'AGESUL', local: 'MS' },
      EMOP: { name: 'EMOP', local: 'RJ' },
      SCO: { name: 'SCO', local: 'RJ' },
    };
    const basesDaComposicao: Array<{
      name: string; local: string; version: string; status: boolean; with_labor_charges?: boolean;
    }> = [];
    for (const nome of basesEdital) {
      const cfg = BANK_NORMALIZATION[nome] as BankConfig | undefined;
      if (!cfg) {
        warnings.push(`Banco "${nome}" não mapeado em BANK_NORMALIZATION — pulando.`);
        continue;
      }
      basesDaComposicao.push({
        name: cfg.name,
        // Usa local fixo do banco (ORSE→SE, SBC→BA) se houver; senão usa UF do edital
        local: cfg.local || ufEdital,
        version: dataBaseEdital,
        status: true,
        with_labor_charges: !cabecalho.com_desoneracao,
      });
    }
    console.log(
      `[cadastrar-edital] bases da composição: ${basesEdital.join('+')} ${ufEdital} ${dataBaseEdital}`,
    );

    const composicaoIds = composicoes.map((c) => c.id);
    // ordem ASC pra preservar a sequência do edital — sem ordem explícita,
    // a UI do Orçafascio acaba alfabetizando os sub-itens.
    const { data: subItens, error: subErr } = await admin
      .from('composicao_propria_itens')
      .select('composicao_extraida_id, classe, codigo, fonte, descricao, unidade, coeficiente, preco_unitario, ordem')
      .in('composicao_extraida_id', composicaoIds)
      .order('ordem', { ascending: true });
    if (subErr) {
      return errorResponse(500, 'Falha ao ler composicao_propria_itens.', subErr.message);
    }

    // Agrupa sub-itens por composição (ordem já garantida pelo SELECT acima)
    const subItensByCompId = new Map<string, ComposicaoPropriaItem[]>();
    for (const s of (subItens ?? [])) {
      const list = subItensByCompId.get(s.composicao_extraida_id) ?? [];
      list.push(s);
      subItensByCompId.set(s.composicao_extraida_id, list);
    }

    // ---- 2) Transição: criando_composicoes_edital -----------------------------
    if (licitacao.status === 'aguardando_revisao_humana') {
      await admin
        .from('licitacoes')
        .update({ status: 'criando_composicoes_edital' })
        .eq('id', licitacaoId);
    }

    // ---- 3) Autentica no Orçafascio ------------------------------------------
    const session = await authenticateOrcafascio(admin, credentialId, {
      callerUserId: user.id,
      forceRefresh: body.force_relog === true,
      traceId,
      licitacaoId,
    });

    const ctx = {
      admin,
      session,
      credentialId,
      callerUserId: user.id,
      licitacaoId,
      traceId,
    };

    // ---- 4) Find-or-create grupo -----------------------------------------------
    // Idempotência: se já existe grupo com mesma descrição, reusa (retry
    // depois de erro não cria duplicata e nem 422 'já está utilizada').
    const grupoDescricao = [
      'EDITAL',
      licitacao.numero_edital ?? licitacao.id.slice(0, 8),
      licitacao.municipio,
      licitacao.uf,
    ].filter(Boolean).join(' / ').slice(0, 200);

    const existingGroup = await findGroupByDescription(ctx, grupoDescricao);
    const grupo = existingGroup
      ? existingGroup
      : await createGroup(ctx, { description: grupoDescricao });
    console.log(
      `[cadastrar-edital] grupo ${existingGroup ? 'reusado' : 'criado'}: ${grupo.id} — ${grupoDescricao}`,
    );

    // ---- 4.5) Pré-cria resources auxiliares pra sub-composições PROPRIA --------
    // Editais frequentemente têm composições próprias que internamente referenciam
    // OUTRAS composições próprias auxiliares (ex: PARALELEPIPEDO+FRETE dentro de
    // PAVIMENTAÇÃO). Essas auxiliares não viram linha do orçamento — só servem
    // de "categoria de custo" interna. No MyBase do Orçafascio, isso é resolvido
    // tratando-as como RESOURCES (insumos com preço fixo).
    //
    // Sem isso: add-items envia { bank: 'MYBASE', code: '07', is_resource: false }
    // → Orçafascio busca composição com code='07', não acha → 500.
    const uf = pickUF(licitacao.uf);
    const auxSubItens = (subItens ?? []).filter(
      (s) => s.fonte === 'PROPRIA' && s.classe === 'COMPOSICAO' && s.codigo,
    );
    const auxByOriginalCode = new Map<string, { resource_code: string }>();
    if (auxSubItens.length > 0) {
      // Dedup por código (com a 1ª descrição/preço/unidade encontrados)
      const uniques = new Map<string, ComposicaoPropriaItem>();
      for (const s of auxSubItens as ComposicaoPropriaItem[]) {
        if (!uniques.has(s.codigo!)) uniques.set(s.codigo!, s);
      }
      console.log(
        `[cadastrar-edital] ${uniques.size} sub-composições PROPRIA auxiliares pra cadastrar como Resource`,
      );

      for (const aux of uniques.values()) {
        // Code único por licitação pra não colidir entre editais
        const auxCode = `AUX_${licitacaoId.slice(0, 8)}_${aux.codigo!}`.slice(0, 50);
        const preco = aux.preco_unitario != null ? Number(aux.preco_unitario) : 0;
        try {
          const existing = await findMyBaseResourceByCode(ctx, auxCode);
          if (existing) {
            // Se o preço existente está zerado (criado por versão buggy
            // anterior), apaga e recria com o preço correto.
            const existingPnd = Number(
              existing.locals?.[uf]?.pnd ?? 0,
            );
            if (existingPnd > 0 || preco === 0) {
              auxByOriginalCode.set(aux.codigo!, { resource_code: existing.code });
              continue;
            }
            console.log(
              `[cadastrar-edital] resource ${auxCode} existente com pnd=${existingPnd} — recriando com ${preco}`,
            );
            await deleteResource(ctx, existing.id).catch((e) => {
              warnings.push(
                `Falha ao apagar resource zerado ${auxCode}: ${e instanceof Error ? e.message.slice(0, 100) : String(e)}`,
              );
            });
          }
          const resource = await createResource(ctx, {
            group_id: grupo.id,
            code: auxCode,
            description: (aux.descricao ?? `Sub-composição auxiliar ${aux.codigo}`).slice(0, 500),
            type: RESOURCE_TYPE.OUTROS,
            unit: (aux.unidade ?? 'un').slice(0, 20),
            local: uf,
            // Mesmo preço nos 4 campos — não desonerado/desonerado/improdutivo
            // (o cálculo correto vem do BDI + leis sociais do orçamento)
            pnd: preco,
            pd: preco,
            pndi: preco,
            pdi: preco,
            note: `Auxiliar do edital ${licitacao.numero_edital ?? licitacao.id.slice(0, 8)}. Código original "${aux.codigo}".`,
          });
          auxByOriginalCode.set(aux.codigo!, { resource_code: resource.code });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          warnings.push(`Resource auxiliar "${auxCode}" — falhou: ${msg.slice(0, 200)}`);
        }
      }
    }

    // ---- 5) Pra cada composição PRÓPRIA: cria + adiciona itens -----------------
    let composicoesCriadas = 0;
    let composicoesPuladas = 0;
    let itensAdicionados = 0;

    for (const comp of (composicoes as ComposicaoExtraida[])) {
      // Idempotência: se já tem orcafascio_composition_id, pula
      if (comp.orcafascio_composition_id) {
        composicoesPuladas++;
        continue;
      }

      // Code da composição no MyBase. Formato 'COMPOSIC_<item_codigo>':
      // - mais legível na tela do orçamento (col CÓDIGO mostra 'COMPOSIC_1.1')
      // - bate com o padrão do edital ('COMPOSIC', 'COMPOSIÇÃO' são genéricos)
      // - sufixo item_codigo garante unicidade dentro da licitação
      // OBS: companies com várias licitações podem ter colisão (mesmo item_codigo
      // "1.1" em editais diferentes) — mas o find-or-create reusa, sem 422.
      // IMPORTANTE: removemos PONTOS do code também — find_by_code do
      // Orçafascio retorna 500 silencioso pra codes com múltiplos pontos
      // (ex: "COMPOSIC_1.1.1"). Trocando ponto por underscore resolve.
      const sanitized = comp.item_codigo
        .replace(/[^A-Za-z0-9_-]/g, '_')
        .slice(0, 40);
      const codigo = `COMPOSIC_${sanitized}`.slice(0, 50);
      const descricao = (comp.descricao ?? 'Composição própria do edital').slice(0, 500);
      const unidade = (comp.unidade ?? 'Un').slice(0, 20);

      // Tipo da composição: usamos "PARE" (paredes) como default genérico —
      // o orçamentista pode reclassificar dentro do Orçafascio se preciso.
      // TODO: inferir do tipo do item via LLM (futuro)
      const tipo: typeof COMPOSITION_TYPES[number] = 'PARE';

      // Find-or-create composição por code (único: licitacao_id + item_codigo).
      // Reusa em retry; só cria se nao achar.
      let created;
      let foiCriadaAgora = false;
      try {
        const existing = await findCompositionByCode(ctx, codigo);
        if (existing) {
          created = existing;
          composicoesPuladas++;
          console.log(`[cadastrar-edital] composição reusada: ${codigo} → ${existing.id}`);
        } else {
          foiCriadaAgora = true;
          created = await createComposition(ctx, {
            code: codigo,
            second_code: `LICITACAO_${licitacaoId.slice(0, 8)}_${comp.item_codigo
              .replace(/[^A-Za-z0-9_-]/g, '_')
              .slice(0, 30)}`,
            description: descricao,
            labor: false,
            type: tipo,
            unit: unidade,
            local: uf,
            // CRÍTICO PARA LICITAÇÃO: TRUNCAR sempre arredonda PRA BAIXO.
            // Nosso orçamento NUNCA pode ter valor maior que o edital
            // (desclassificação). ARREDONDAR (half-up) pode somar centavos
            // por cima do edital — usamos TRUNCAR pra garantir ≤ edital.
            rounding_type: ROUNDING_TYPE.TRUNCAR_2_CASAS,
            is_sicro: false,
            note: `Composição extraída do edital. Item ${comp.item_codigo}.`,
          });
          composicoesCriadas++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`Composição "${codigo}" — falhou: ${msg}`);
        continue;
      }

      // Configura bases (SINAPI/SICRO/ORSE/etc) com UF + data-base do edital.
      // Composições criadas usam default da conta (SINAPI/AC/01-2026), e os
      // códigos do edital (que vivem em PI/02-2026 ou similar) retornam 500
      // no addItemsToComposition sem isso. Chamamos SEMPRE (mesmo em retry)
      // pra garantir que composições reusadas de tentativas antigas também
      // tenham as bases corretas. Best-effort: warning não fatal.
      if (basesDaComposicao.length > 0) {
        try {
          await addBasesToComposition(ctx, created.id, basesDaComposicao);
        } catch (e) {
          // 422 "already in use" (idempotência) é OK; outros 422 (Local
          // not found, Base not found) precisam de aviso pq itens vão
          // falhar com 500.
          const details = (e instanceof OrcafascioApiError && e.details) || null;
          const detailsStr = details ? JSON.stringify(details).slice(0, 200) : '';
          const isAlreadyInUse = detailsStr.toLowerCase().includes('already_in_use') ||
            detailsStr.toLowerCase().includes('já está utilizada');
          if (!isAlreadyInUse) {
            warnings.push(
              `Composição "${codigo}": addBases falhou ${detailsStr || (e instanceof Error ? e.message.slice(0, 120) : '')}. Items dessas bases podem falhar com 500.`,
            );
          }
        }
      }

      // Adiciona sub-itens da composição própria.
      // Cada sub-item pode ser COMPOSICAO ou INSUMO (MAT/EQUIPAMENTO).
      // Orçafascio exige is_resource pra distinguir — sem isso, 500 quando
      // mistura COMPOSICAO + INSUMO na mesma composição.
      //
      // Sub-composições PROPRIA auxiliares (ex: codigo "07" PARALELEPIPEDO)
      // foram pré-cadastradas como RESOURCES no MyBase no passo 4.5. Aqui
      // substituímos o codigo original pelo code do resource e marcamos
      // is_resource: true.
      const subs = subItensByCompId.get(comp.id) ?? [];
      // LIMITAÇÃO conhecida da API pública do Orçafascio: insumos do MyBase
      // (resources cadastrados pela empresa) NÃO podem ser sub-itens de outra
      // composição MyBase via /add-items (sempre devolve 500). Por isso os
      // sub-itens PROPRIA+COMPOSICAO auxiliares (AUX_XX) vão pro warning
      // pra o orçamentista adicionar manualmente na UI web.
      const itemsParaApi: CompositionItem[] = [];
      const subItensManuais: string[] = [];
      for (const s of subs) {
        if (!s.codigo || s.coeficiente == null || s.coeficiente <= 0) continue;
        const isAuxPropria = s.fonte === 'PROPRIA' && s.classe === 'COMPOSICAO';
        if (isAuxPropria) {
          const aux = auxByOriginalCode.get(s.codigo);
          subItensManuais.push(
            `[Adicionar manual] ${s.codigo} ${(s.descricao ?? '').slice(0, 60)}` +
            (aux ? ` (Resource MyBase: ${aux.resource_code}, ${s.unidade ?? ''}, ${s.preco_unitario != null ? `R$ ${Number(s.preco_unitario).toFixed(2)}` : 'sem preço'}) — coef ${s.coeficiente}` : ''),
          );
          continue;
        }
        itemsParaApi.push({
          bank: fonteToBank(s.fonte),
          code: s.codigo,
          qty: s.coeficiente,
          // classe='COMPOSICAO' → type:'composition'; outros (INSUMO, MAT,
          // EQUIPAMENTO) → type:'resource'.
          type: s.classe === 'COMPOSICAO' ? 'composition' : 'resource',
        });
      }
      const items = itemsParaApi;
      if (subItensManuais.length > 0) {
        warnings.push(
          `Composição "${codigo}": ${subItensManuais.length} sub-item(ns) PROPRIA auxiliar — Orçafascio API não aceita resource MyBase como sub-item, adicione manualmente na UI: ${subItensManuais.join('; ')}`,
        );
      }

      // Se reusou uma composição que já tem itens, NÃO adiciona de novo
      // (evita duplicar). Só adiciona se está vazia (recover de attempt
      // que criou comp mas falhou no addItems).
      const itensExistentes = ((created as { items?: unknown[] }).items ?? []).length;
      if (items.length > 0 && itensExistentes === 0) {
        try {
          await addItemsToComposition(ctx, created.id, items);
          itensAdicionados += items.length;
        } catch (err) {
          // Batch falhou com 500 (HTML genérico, sem detalhes do item ruim).
          // Tenta item por item pra identificar o(s) problemático(s) — os
          // que funcionarem ficam adicionados, os que falharem viram warning
          // específico com o code/bank/qty pra debug.
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`[cadastrar-edital] batch ${codigo} falhou (${msg}), tentando item a item`);
          let oneByOneOk = 0;
          const failures: string[] = [];
          for (const it of items) {
            try {
              await addItemsToComposition(ctx, created.id, [it]);
              oneByOneOk++;
            } catch (e2) {
              const m2 = e2 instanceof Error ? e2.message : String(e2);
              failures.push(`${it.bank}/${it.code} (qty ${it.qty}, type ${it.type}) → ${m2.slice(0, 100)}`);
            }
          }
          itensAdicionados += oneByOneOk;
          if (failures.length > 0) {
            warnings.push(
              `Composição "${codigo}": ${oneByOneOk}/${items.length} itens OK, falhas: ${failures.join('; ')}`,
            );
          }
        }
      }

      // Atualiza orcafascio_composition_id no banco
      await admin
        .from('composicoes_extraidas')
        .update({ orcafascio_composition_id: created.id })
        .eq('id', comp.id);
    }

    // ---- 6) Transição: fase1_concluida -----------------------------------------
    await admin
      .from('licitacoes')
      .update({
        status: 'fase1_concluida',
        fase1_concluida_em: new Date().toISOString(),
      })
      .eq('id', licitacaoId);

    return jsonResponse({
      ok: true,
      grupo_id: grupo.id,
      grupo_descricao: grupoDescricao,
      composicoes_criadas: composicoesCriadas,
      composicoes_puladas: composicoesPuladas,
      itens_adicionados: itensAdicionados,
      warnings,
      trace_id: traceId,
      proximo_passo: 'No Orçafascio: crie um novo Orçamento e selecione a pasta criada pra importar as composições.',
    });
  } catch (err) {
    // Em falha, transiciona pra 'erro'
    if (licitacaoId) {
      await admin.from('licitacoes').update({ status: 'erro' }).eq('id', licitacaoId);
    }
    if (err instanceof OrcafascioAuthError) {
      return errorResponse(ERR_AUTH_TO_HTTP[err.code], err.message, err.details);
    }
    if (err instanceof OrcafascioApiError) {
      return errorResponse(502, err.message, { endpoint: err.endpoint, details: err.details });
    }
    if (err instanceof HttpError) {
      return errorResponse(err.status, err.message, err.details);
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cadastrar-edital] erro inesperado:', err);
    return errorResponse(500, msg);
  }
});
