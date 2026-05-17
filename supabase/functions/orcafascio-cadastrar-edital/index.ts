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
      const sanitized = comp.item_codigo
        .replace(/[^A-Za-z0-9._-]/g, '_')
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
      try {
        const existing = await findCompositionByCode(ctx, codigo);
        if (existing) {
          created = existing;
          composicoesPuladas++;
          console.log(`[cadastrar-edital] composição reusada: ${codigo} → ${existing.id}`);
        } else {
          created = await createComposition(ctx, {
            code: codigo,
            second_code: `LICITACAO_${licitacaoId.slice(0, 8)}_${comp.item_codigo
              .replace(/[^A-Za-z0-9._-]/g, '_')
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
      const items: CompositionItem[] = subs
        .filter((s) => s.codigo && s.coeficiente != null && s.coeficiente > 0)
        .map((s) => {
          const isAuxPropria = s.fonte === 'PROPRIA' && s.classe === 'COMPOSICAO';
          const aux = isAuxPropria ? auxByOriginalCode.get(s.codigo!) : null;
          if (aux) {
            // Substitui pela referência ao resource auxiliar
            return {
              bank: 'MYBASE',
              code: aux.resource_code,
              qty: s.coeficiente!,
              is_resource: true,
            };
          }
          return {
            bank: fonteToBank(s.fonte),
            code: s.codigo!,
            qty: s.coeficiente!,
            // classe='COMPOSICAO' → is_resource:false; outros (INSUMO, MAT,
            // EQUIPAMENTO) → is_resource:true (são "recursos"/insumos)
            is_resource: s.classe !== 'COMPOSICAO',
          };
        });

      // Se reusou uma composição que já tem itens, NÃO adiciona de novo
      // (evita duplicar). Só adiciona se está vazia (recover de attempt
      // que criou comp mas falhou no addItems).
      const itensExistentes = ((created as { items?: unknown[] }).items ?? []).length;
      if (items.length > 0 && itensExistentes === 0) {
        try {
          await addItemsToComposition(ctx, created.id, items);
          itensAdicionados += items.length;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          warnings.push(
            `Composição "${codigo}" criada (${created.id}) mas adição de ${items.length} itens falhou: ${msg}`,
          );
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
