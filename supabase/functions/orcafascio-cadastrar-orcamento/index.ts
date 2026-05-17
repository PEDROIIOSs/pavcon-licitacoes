// =============================================================================
// Edge Function: orcafascio-cadastrar-orcamento
// =============================================================================
// CRIAÇÃO COMPLETA do orçamento no Orçafascio via API interna /v2023/.
//
// Fluxo:
//   1. Auth web (cookie _orcafascio_session via orcafascio-web-auth helper)
//   2. POST /orc/orcamentos          → cria budget, capta budget_id
//   3. POST /v2023/.../update_bases  → bancos de referência (SINAPI, etc.)
//   4. POST /v2023/.../update_bdi    → BDI extraído da licitação
//   5. POST /v2023/.../update_leis_sociais → encargos sociais
//   6. POST /v2023/bud/budgets/{id}/items/ → BATCH com etapas + composições
//   7. Atualiza orcafascio_orcamento_id na licitação + status=fase1_concluida
//
// Body (JSON):
//   {
//     "licitacao_id": "uuid",       // obrigatório
//     "credential_id": "uuid",       // obrigatório — provider=orcafascio + auth_type=web
//     "trace_id": "uuid"             // opcional
//   }
//
// Resposta 200:
//   {
//     "ok": true,
//     "budget_id": "6a087cb1...",
//     "budget_url": "https://app.orcafascio.com/orc/orcamentos/...",
//     "etapas_criadas": 7,
//     "composicoes_criadas": 16,
//     "trace_id": "..."
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
  authenticateOrcafascioWeb,
  OrcafascioWebError,
} from '../_shared/orcafascio-web.ts';
import {
  addItemsBatch,
  type BudgetItem,
  createBudget,
  createContext,
  fonteToBase,
  OrcafascioV2023Error,
  updateBases,
  updateBdi,
  updateLeisSociais,
  uuidv4,
} from '../_shared/orcafascio-web-v2023.ts';

interface RequestBody {
  licitacao_id?: string;
  credential_id?: string;
  trace_id?: string;
  /** Cria uma 2ª versão como PROPOSTA. BDI permanece igual ao edital
   * (regra de licitação: desconto não incide sobre BDI). Pra aplicar o
   * desconto, futuras iterações vão enviar pu_override por item — esta
   * versão da Edge Function ainda não suporta isso (TODO). */
  proposta?: {
    /** Prefixo no título do orçamento. Default: 'PROPOSTA - ' */
    titulo_prefix?: string;
    /** TODO: pu sobrescrito por item_codigo pra aplicar desconto
     * seletivo (não incide sobre mão de obra). */
    pus_override?: Record<string, number>;
  };
}

const ERR_AUTH_TO_HTTP: Record<OrcafascioWebError['code'], number> = {
  credential_not_found: 404,
  credential_inactive: 403,
  credential_wrong_provider: 400,
  credential_no_email: 422,
  credential_wrong_auth_type: 400,
  vault_unreadable: 500,
  csrf_not_found: 502,
  login_rejected: 422,
  login_unreachable: 502,
  login_unexpected: 502,
};

// Bancos suportados pelo Orçafascio /v2023/.../update_bases.
// Inspeção do form real revelou:
// - `has_state: true` → form tem select `{nome}_estado` (precisa enviar)
// - `has_state: false` → estado implícito (NÃO mandar `_estado`, gera 500)
// Nomes seguem EXATAMENTE o que aparece no form HTML (ex: 'SICRO3', não 'SICRO').
const ORCAFASCIO_BANKS: Record<string, { has_state: boolean }> = {
  SINAPI: { has_state: true },
  SBC: { has_state: true },
  SICRO3: { has_state: true },
  SETOP: { has_state: true },
  EMBASA: { has_state: true },
  // Estado implícito (single-state ou regional)
  SIURB: { has_state: false },
  'SIURB INFRA': { has_state: false },
  FDE: { has_state: false },
  CPOS: { has_state: false },
  EMOP: { has_state: false },
  SCO: { has_state: false },
  SUDECAP: { has_state: false },
  IOPES: { has_state: false },
  ORSE: { has_state: false },
  SEINFRA: { has_state: false },
  CAEMA: { has_state: false },
  CAERN: { has_state: false },
  COMPESA: { has_state: false },
  AGESUL: { has_state: false },
  'AGETOP CIVIL': { has_state: false },
  'AGETOP RODOVIARIA': { has_state: false },
  SEDOP: { has_state: false },
  DERPR: { has_state: false },
};

// Extrai data MM/AAAA do data_base_descricao pra um banco específico.
// Estado só é relevante pra bancos com `has_state: true` (SINAPI, SICRO3, etc.).
function inferBaseData(
  cabecalho: Record<string, unknown> | null,
  banco: string,
): { estado: string; data: string } {
  const desc = String(cabecalho?.data_base_descricao ?? '');
  const ufLicit = String(cabecalho?.uf ?? 'PI').toUpperCase().slice(0, 2);
  // Variantes do regex pra cobrir "SICRO3" sendo procurado como "SICRO" também
  const variantes = [banco, banco.replace(/3$/, ''), banco + '3'];
  for (const v of variantes) {
    const re = new RegExp(`${v}[^\\d]*?([A-Z]{2})?[^\\d]*?(\\d{2}\\/\\d{4})`, 'i');
    const m = desc.match(re);
    if (m) {
      return { estado: (m[1] ?? ufLicit).toUpperCase(), data: m[2] };
    }
  }
  // Fallback: mês passado
  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const data = `${String(lastMonth.getMonth() + 1).padStart(2, '0')}/${lastMonth.getFullYear()}`;
  return { estado: ufLicit, data };
}

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
  if (!credentialId) return errorResponse(400, 'credential_id é obrigatório (web auth_type=web).');

  const traceId = body.trace_id ?? crypto.randomUUID();
  const isProposta = body.proposta != null;
  const admin = getServiceRoleClient();

  try {
    const user = await requireAuthenticatedUser(req);

    // ---- 1) Carrega licitação + composições -----------------------------------
    const { data: licitacao, error: licErr } = await admin
      .from('licitacoes')
      .select('id, titulo, numero_edital, orgao_licitante, municipio, uf, status, bdi_referencia_edital')
      .eq('id', licitacaoId)
      .maybeSingle();
    if (licErr || !licitacao) {
      return errorResponse(404, 'Licitação não encontrada.', licErr?.message);
    }
    const ALLOWED = new Set([
      'aguardando_revisao_humana',
      'criando_composicoes_edital',
      'criando_orcamento_base',
      'fase1_concluida',
    ]);
    if (!ALLOWED.has(licitacao.status)) {
      return errorResponse(
        409,
        `Licitação está em "${licitacao.status}" — precisa estar em: ${[...ALLOWED].join(', ')}.`,
      );
    }

    // Pega o JSON extraído pra cabecalho (BDI, leis sociais, bases)
    const { data: extr } = await admin
      .from('extracoes_ocr')
      .select('json_corrigido, json_extraido')
      .eq('licitacao_id', licitacaoId)
      .in('status', ['sucesso', 'revisada_humano'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const json = (extr?.json_corrigido ?? extr?.json_extraido) as {
      cabecalho?: Record<string, unknown>;
    } | null;
    const cabecalho = json?.cabecalho ?? null;
    // BDI sempre = BDI do edital (regra de licitação: desconto não incide
    // sobre BDI, ele permanece igual entre edital e proposta).
    const bdiEdital = Number(cabecalho?.bdi_percentual ?? licitacao.bdi_referencia_edital ?? 22);
    const bdiPct = bdiEdital;
    const leisHorista = Number(cabecalho?.leis_sociais_percentual ?? 113.78);
    const comDesoneracao = Boolean(cabecalho?.com_desoneracao);
    const basesUtilizadas = Array.isArray(cabecalho?.bases_utilizadas)
      ? (cabecalho.bases_utilizadas as string[])
      : ['SINAPI'];

    // Pega composições ordenadas
    const { data: comps, error: compErr } = await admin
      .from('composicoes_extraidas')
      .select(
        'id, item_codigo, item_nivel, item_pai_codigo, tipo_linha, codigo, fonte, descricao, quantidade, orcafascio_composition_id, ordem',
      )
      .eq('licitacao_id', licitacaoId)
      .order('ordem', { ascending: true });
    if (compErr) {
      return errorResponse(500, 'Falha ao ler composicoes_extraidas.', compErr.message);
    }
    if (!comps || comps.length === 0) {
      return errorResponse(422, 'Nenhuma composição extraída pra cadastrar.');
    }

    // ---- 2) Transição: criando_orcamento_base --------------------------------
    // PROPOSTA: não transiciona status (orçamento base já existe e está fase1_concluida)
    if (!isProposta && ['aguardando_revisao_humana', 'criando_composicoes_edital'].includes(licitacao.status)) {
      // Vai pra criando_composicoes_edital se estiver em aguardando_revisao_humana
      if (licitacao.status === 'aguardando_revisao_humana') {
        await admin.from('licitacoes').update({ status: 'criando_composicoes_edital' }).eq('id', licitacaoId);
      }
      await admin.from('licitacoes').update({ status: 'criando_orcamento_base' }).eq('id', licitacaoId);
    }

    // ---- 3) Auth web no Orçafascio -------------------------------------------
    const session = await authenticateOrcafascioWeb(admin, credentialId, {
      callerUserId: user.id,
      traceId,
      licitacaoId,
    });

    const ctx = await createContext(admin, session, credentialId, user.id, licitacaoId, traceId);

    // ---- 4) Cria o budget ----------------------------------------------------
    // Codigo precisa ser único — adiciona suffix com data+hora pra evitar conflito
    // de unicidade no Orçafascio (caso o orçamentista crie múltiplos pra mesma obra).
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const baseCod = (licitacao.municipio ?? 'OBRA').toUpperCase().slice(0, 30);
    const tituloPrefix = body.proposta?.titulo_prefix ?? (isProposta ? 'PROPOSTA - ' : '');
    const codigo = `${isProposta ? 'PROP ' : ''}${baseCod} ${stamp}`.slice(0, 50);
    const descricao = `${tituloPrefix}${licitacao.titulo ?? 'Orçamento gerado pelo bot'}`.slice(0, 250);

    const { budget_id } = await createBudget(ctx, {
      codigo,
      descricao,
      standard_category_name: 'Infraestruturas Esportivas - Reforma',
      licitacao: true,
      version_2023: true,
      mask_itemization: true,
      insumos_zerados: true,
      rounding_option: 1,
    });

    // ---- 5/6/7) Configurações best-effort ------------------------------------
    // Essas chamadas podem falhar individualmente sem matar o fluxo (o crítico
    // é criar o budget + add items, que vem depois). Coletamos warnings.
    const warnings: string[] = [];

    // Normaliza variantes pro nome canônico do Orçafascio.
    // Ex: 'SICRO' → 'SICRO3' (Orçafascio usa SICRO3 oficial).
    function normalizeBanco(b: string): string {
      const u = b.toUpperCase().trim();
      if (u.startsWith('SINAPI')) return 'SINAPI';
      if (u.startsWith('SICRO')) return 'SICRO3'; // SICRO ou SICRO3 → SICRO3
      if (u.startsWith('SEINFRA')) return 'SEINFRA';
      if (u.startsWith('ORSE')) return 'ORSE';
      if (u.startsWith('SBC')) return 'SBC';
      if (u.startsWith('FDE')) return 'FDE';
      if (u.startsWith('SUDECAP')) return 'SUDECAP';
      if (u.startsWith('SETOP')) return 'SETOP';
      if (u.startsWith('EMBASA')) return 'EMBASA';
      if (u.startsWith('CPOS')) return 'CPOS';
      if (u.startsWith('EMOP')) return 'EMOP';
      if (u.startsWith('SCO')) return 'SCO';
      if (u.startsWith('IOPES')) return 'IOPES';
      if (u.startsWith('CAEMA')) return 'CAEMA';
      if (u.startsWith('CAERN')) return 'CAERN';
      if (u.startsWith('COMPESA')) return 'COMPESA';
      if (u.startsWith('AGESUL')) return 'AGESUL';
      if (u.startsWith('SEDOP')) return 'SEDOP';
      if (u.startsWith('DERPR')) return 'DERPR';
      if (u.startsWith('SIURB INFRA')) return 'SIURB INFRA';
      if (u.startsWith('SIURB')) return 'SIURB';
      if (u.startsWith('AGETOP CIVIL')) return 'AGETOP CIVIL';
      if (u.startsWith('AGETOP RODOVIARIA')) return 'AGETOP RODOVIARIA';
      return u;
    }
    const bancos = Array.from(new Set(basesUtilizadas.map(normalizeBanco)))
      .filter((b) => b in ORCAFASCIO_BANKS)
      .map((nome) => {
        const meta = ORCAFASCIO_BANKS[nome];
        const { estado, data } = inferBaseData(cabecalho, nome);
        // Só inclui `estado` se o banco tiver select de estado no form.
        // Bancos com estado implícito (ORSE, SEINFRA, etc.) NÃO devem receber
        // _estado — gera 500 no Orçafascio.
        return {
          nome,
          ...(meta.has_state ? { estado } : {}),
          data,
          exibir_relatorio: true,
        };
      });
    if (bancos.length > 0) {
      // updateBases agora lê os defaults do form (todos os ~23 bancos) e
      // faz merge com os que queremos sobrescrever. Rails exige form completo.
      try {
        await updateBases(ctx, budget_id, {
          bancos,
          atualizar_composicoes: true,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        warnings.push(
          `updateBases falhou (configurar manualmente no Orçafascio): ${msg.slice(0, 150)}`,
        );
      }
    }

    try {
      // no_final=false: BDI incide sobre o preço UNITÁRIO da composição
      // (método recomendado pelo TCU e usado pelos orçamentos base do
      // órgão). Faz com que o total por item já apareça com BDI no Orçafascio,
      // batendo com a planilha do edital.
      await updateBdi(ctx, budget_id, { bdi_manual: bdiPct, no_final: false });
    } catch (e) {
      warnings.push(`updateBdi falhou: ${e instanceof Error ? e.message.slice(0, 150) : String(e)}`);
    }

    try {
      await updateLeisSociais(ctx, budget_id, {
        desonerado: comDesoneracao,
        charge_hourly: leisHorista,
        charge_monthly: leisHorista * 0.629, // razão típica horista→mensalista (71.59/113.78)
      });
    } catch (e) {
      warnings.push(`updateLeisSociais falhou: ${e instanceof Error ? e.message.slice(0, 150) : String(e)}`);
    }

    // ---- 8) Monta batch new_items[] -----------------------------------------
    const items: BudgetItem[] = [];
    let etapasCriadas = 0;
    let composicoesCriadas = 0;

    for (const c of comps) {
      if (c.tipo_linha === 'grupo') {
        items.push({
          kind: 'phase',
          itemization: c.item_codigo,
          descr: (c.descricao ?? '').slice(0, 200),
          parent_descr: c.item_pai_codigo
            ? (comps.find((x) => x.item_codigo === c.item_pai_codigo)?.descricao ?? '').slice(0, 200)
            : '',
          qty: 1,
        });
        etapasCriadas++;
      } else if (c.tipo_linha === 'servico') {
        // Pra fonte=PROPRIA, usar a composição cadastrada no MyBase (via cadastrar-edital).
        // `code` PRECISA ser o código humano da composição no MyBase (ex:
        // '2da42d41_1.1'), não o ObjectId nem o valor genérico do edital.
        // Quando enviamos `code` diferente do que está em MyBase, Orçafascio
        // não resolve o public_banco_id → valor R$ 0,00 no orçamento.
        const isPropria = c.fonte === 'PROPRIA';
        // PRECISA usar o MESMO formato de cadastrar-edital.ts pra Orçafascio
        // achar a composição no MyBase via public_banco_id + code.
        const mybaseCode = `COMPOSIC_${(c.item_codigo as string)
          .replace(/[^A-Za-z0-9._-]/g, '_')
          .slice(0, 40)}`;
        const code = isPropria ? mybaseCode : (c.codigo ?? '');
        if (!code) continue;
        if (isPropria && !c.orcafascio_composition_id) continue;

        items.push({
          kind: 'composition',
          itemization: c.item_codigo,
          base: fonteToBase(c.fonte),
          base_id: uuidv4(),
          public_banco_id: isPropria ? c.orcafascio_composition_id ?? '' : '',
          code: String(code),
          qty: Number(c.quantidade ?? 0),
        });
        composicoesCriadas++;
      }
    }

    if (items.length > 0) {
      // Envia em chunks de até 50 itens pra evitar request muito grande
      const CHUNK = 50;
      for (let i = 0; i < items.length; i += CHUNK) {
        await addItemsBatch(ctx, budget_id, items.slice(i, i + CHUNK));
      }
    }

    // ---- 9) Persiste budget_id na licitação + transição --------------------
    // PROPOSTA: não toca no status (orçamento base mantém fase1_concluida)
    if (!isProposta) {
      await admin
        .from('licitacoes')
        .update({
          status: 'fase1_concluida',
          fase1_concluida_em: new Date().toISOString(),
          orcafascio_orcamento_base_id: budget_id,
          orcafascio_orcamento_base_codigo: codigo,
        })
        .eq('id', licitacaoId);
    }

    // Atualiza extracoes_ocr ou outra tabela com o budget_id pra rastreamento
    // (a tabela licitacoes não tem campo orcafascio_orcamento_id atualmente —
    //  podemos guardar em audit ou criar coluna futura)

    return jsonResponse({
      ok: true,
      budget_id,
      budget_url: `https://app.orcafascio.com/orc/orcamentos/${budget_id}`,
      etapas_criadas: etapasCriadas,
      composicoes_criadas: composicoesCriadas,
      total_itens_batch: items.length,
      bdi: bdiPct,
      leis_sociais_horista: leisHorista,
      bancos_configurados: bancos.map((b) => `${b.nome} ${b.estado} ${b.data}`),
      warnings,
      trace_id: traceId,
      proximo_passo: warnings.length > 0
        ? `Orçamento criado com ${warnings.length} aviso(s) — alguns campos podem precisar ajuste manual. Abra a URL acima pra revisar.`
        : 'Abra o Orçafascio na URL acima pra revisar. O bot configurou cabeçalho, bases, BDI, encargos sociais e adicionou todas as composições.',
    });
  } catch (err) {
    // Em falha, transiciona licitação pra erro (mas NÃO pra proposta —
    // erro na proposta não pode quebrar o status do orçamento base)
    if (licitacaoId && !isProposta) {
      await admin.from('licitacoes').update({ status: 'erro' }).eq('id', licitacaoId);
    }
    if (err instanceof OrcafascioWebError) {
      return errorResponse(ERR_AUTH_TO_HTTP[err.code], err.message, err.details);
    }
    if (err instanceof OrcafascioV2023Error) {
      return errorResponse(502, err.message, { endpoint: err.endpoint, details: err.details });
    }
    if (err instanceof HttpError) {
      return errorResponse(err.status, err.message, err.details);
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cadastrar-orcamento] erro:', err);
    return errorResponse(500, msg);
  }
});
