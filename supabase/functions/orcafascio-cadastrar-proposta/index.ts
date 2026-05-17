// =============================================================================
// Edge Function: orcafascio-cadastrar-proposta
// =============================================================================
// Cria a PROPOSTA READEQUADA no Orçafascio em 2 etapas:
//   1. COPIA o orçamento base (preserva composições, BDI, leis sociais)
//   2. AJUSTA o valor final do novo orçamento pra bater com o valor calculado
//      pela nossa regra MO-aware (desconto não incide sobre mão de obra)
//
// A diferença entre o ajuste linear do Orçafascio e o cálculo MO-aware é
// ASSUMIDA: o total final do orçamento bate (Orçafascio garante), mas a
// distribuição interna por composição pode descontar MO proporcionalmente.
// Pra a maioria dos editais isso é aceitável — o que importa é o total
// (que é o que o órgão licitante avalia).
//
// Body (JSON):
//   { licitacao_id, credential_id, desconto_percentual, valor_proposta? }
//
// Resposta 200:
//   { ok, budget_id, budget_url, valor_aplicado, warnings }
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
  ajustarValor,
  copyBudget,
  createContext,
  OrcafascioV2023Error,
} from '../_shared/orcafascio-web-v2023.ts';

interface RequestBody {
  licitacao_id?: string;
  credential_id?: string;
  desconto_percentual?: number;
  /** Valor final desejado pra proposta (com BDI). Pré-calculado pelo
   * backend respeitando regra de MO. Se omitido, a Edge Function calcula. */
  valor_proposta?: number;
  trace_id?: string;
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

Deno.serve(async (req: Request) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;
  if (req.method !== 'POST') {
    return errorResponse(405, 'Use POST.');
  }

  let body: RequestBody;
  try { body = await req.json(); } catch { return errorResponse(400, 'JSON inválido.'); }

  const licitacaoId = body.licitacao_id?.trim();
  const credentialId = body.credential_id?.trim();
  const desconto = body.desconto_percentual;

  if (!licitacaoId) return errorResponse(400, 'licitacao_id é obrigatório.');
  if (!credentialId) return errorResponse(400, 'credential_id é obrigatório.');
  if (desconto == null || !Number.isFinite(desconto) || desconto <= 0 || desconto >= 100) {
    return errorResponse(400, 'desconto_percentual deve ser entre 0 e 100 (exclusivo).');
  }

  const traceId = body.trace_id ?? crypto.randomUUID();
  const admin = getServiceRoleClient();
  const warnings: string[] = [];

  try {
    const user = await requireAuthenticatedUser(req);

    // ---- 1) Carrega licitação ------------------------------------------------
    const { data: lic, error: licErr } = await admin
      .from('licitacoes')
      .select(
        'id, status, titulo, municipio, bdi_referencia_edital, orcafascio_orcamento_base_id',
      )
      .eq('id', licitacaoId)
      .maybeSingle();
    if (licErr || !lic) {
      return errorResponse(404, 'Licitação não encontrada.', licErr?.message);
    }
    if (lic.status !== 'fase1_concluida' && lic.status !== 'finalizado') {
      return errorResponse(
        409,
        `Licitação precisa estar em fase1_concluida (atual: "${lic.status}").`,
      );
    }
    const sourceBudgetId = lic.orcafascio_orcamento_base_id;
    if (!sourceBudgetId) {
      return errorResponse(
        422,
        'orcafascio_orcamento_base_id não preenchido na licitação. Recadastre o orçamento base ou popule manualmente.',
      );
    }

    // ---- 2) Calcula valor_proposta se não veio do cliente -------------------
    let valorProposta = body.valor_proposta;
    if (valorProposta == null || !Number.isFinite(valorProposta) || valorProposta <= 0) {
      // Fallback: usa cálculo simples (valor_total × (1-desconto%)).
      // Não respeita MO — só serve quando o cliente esqueceu de pré-calcular.
      const { data: comps } = await admin
        .from('composicoes_extraidas')
        .select('preco_total')
        .eq('licitacao_id', licitacaoId)
        .eq('tipo_linha', 'servico');
      const totalEdital = (comps ?? []).reduce(
        (s, c) => s + Number(c.preco_total ?? 0),
        0,
      );
      valorProposta = totalEdital * (1 - desconto / 100);
      warnings.push(
        `valor_proposta não foi fornecido. Calculei desconto LINEAR sobre o total (sem regra de MO): ${valorProposta.toFixed(2)}`,
      );
    }
    if (!Number.isFinite(valorProposta) || valorProposta <= 0) {
      return errorResponse(422, `valor_proposta inválido: ${valorProposta}`);
    }

    // ---- 3) Auth + contexto Orçafascio --------------------------------------
    const session = await authenticateOrcafascioWeb(admin, credentialId, {
      callerUserId: user.id,
      traceId,
      licitacaoId,
    });
    const ctx = await createContext(
      admin, session, credentialId, user.id, licitacaoId, traceId,
      () => authenticateOrcafascioWeb(admin, credentialId, {
        callerUserId: user.id,
        forceRefresh: true,
        traceId,
        licitacaoId,
      }),
    );

    // ---- 4) Copia o orçamento base ------------------------------------------
    const { budget_id: novoBudgetId } = await copyBudget(ctx, sourceBudgetId);

    // ---- 5) Aplica ajustar_valor -------------------------------------------
    // O Orçafascio aplica o fator linear sobre TODOS os itens pra alcançar
    // exatamente o `valorProposta`. Como esse valor já respeita a regra de
    // MO (calculado no backend), o resultado total bate, embora a divisão
    // interna fique linear.
    try {
      await ajustarValor(ctx, novoBudgetId, valorProposta);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push(`ajustarValor falhou: ${msg.slice(0, 200)} — orçamento copiado mas sem desconto aplicado`);
    }

    // ---- 6) Persiste budget_id da proposta na licitação --------------------
    await admin
      .from('licitacoes')
      .update({
        desconto_percentual: desconto,
        valor_proposta_pavcon: valorProposta,
        orcafascio_proposta_budget_id: novoBudgetId,
      })
      .eq('id', licitacaoId);

    return jsonResponse({
      ok: true,
      budget_id: novoBudgetId,
      budget_url: `https://app.orcafascio.com/orc/orcamentos/${novoBudgetId}`,
      source_budget_id: sourceBudgetId,
      valor_aplicado: valorProposta,
      desconto_percentual: desconto,
      warnings,
      trace_id: traceId,
      proximo_passo:
        'Abra o link no Orçafascio pra revisar o orçamento da proposta. Total deve bater com o cálculo MO-aware do PavCon — a divisão interna por item segue ajuste linear do Orçafascio (desconta MO proporcionalmente).',
    });
  } catch (err) {
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
    console.error('[cadastrar-proposta] erro:', err);
    return errorResponse(500, msg);
  }
});
