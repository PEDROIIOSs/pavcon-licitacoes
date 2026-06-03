// =============================================================================
// Edge Function: orcafascio-ajustar-total
// =============================================================================
// Força o total do orçamento BASE no Orçafascio a bater com `valor_total_alvo`.
// Útil quando o cadastramento ficou incompleto (composições próprias em branco,
// codes descontinuados) e o total ficou abaixo do que o edital pede. Aplica o
// "Ajustar valor" do Orçafascio — fator linear sobre todos os itens não-zero.
//
// LIMITAÇÃO: ajuste é proporcional. Composições com R$ 0,00 continuam R$ 0,00.
// Composições com preço inflam pelo fator. Total bate, distribuição imperfeita.
// Pra estrutura correta, ainda precisa popular os sub-itens das composições.
//
// Body:
//   { licitacao_id, credential_id, valor_total_alvo }
// =============================================================================

import { handleCorsPreflight } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/json.ts';
import {
  getServiceRoleClient,
  requireAuthenticatedUser,
} from '../_shared/supabase.ts';
import {
  authenticateOrcafascioWeb,
  OrcafascioWebError,
} from '../_shared/orcafascio-web.ts';
import {
  ajustarValor,
  createContext,
  OrcafascioV2023Error,
} from '../_shared/orcafascio-web-v2023.ts';

interface RequestBody {
  licitacao_id?: string;
  credential_id?: string;
  valor_total_alvo?: number;
  trace_id?: string;
}

Deno.serve(async (req: Request) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse(405, 'Use POST.');

  let body: RequestBody;
  try { body = await req.json(); } catch { return errorResponse(400, 'JSON inválido.'); }

  const licitacaoId = body.licitacao_id?.trim();
  const credentialId = body.credential_id?.trim();
  const valorAlvo = body.valor_total_alvo;

  if (!licitacaoId) return errorResponse(400, 'licitacao_id é obrigatório.');
  if (!credentialId) return errorResponse(400, 'credential_id é obrigatório.');
  if (!Number.isFinite(valorAlvo) || (valorAlvo as number) <= 0) {
    return errorResponse(400, `valor_total_alvo inválido: ${valorAlvo}`);
  }

  const traceId = body.trace_id ?? crypto.randomUUID();
  const admin = getServiceRoleClient();

  try {
    const user = await requireAuthenticatedUser(req);

    // ---- 1) Carrega licitação + budget_id ----------------------------------
    const { data: lic, error: licErr } = await admin
      .from('licitacoes')
      .select('id, status, titulo, orcafascio_orcamento_base_id')
      .eq('id', licitacaoId)
      .maybeSingle();
    if (licErr || !lic) return errorResponse(404, 'Licitação não encontrada.', licErr?.message);

    const budgetId = lic.orcafascio_orcamento_base_id;
    if (!budgetId) {
      return errorResponse(
        422,
        'orcafascio_orcamento_base_id não preenchido. Cadastre o orçamento primeiro.',
      );
    }

    // ---- 2) Autentica Orçafascio web ---------------------------------------
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

    // ---- 3) Aplica ajustarValor --------------------------------------------
    await ajustarValor(ctx, budgetId, valorAlvo as number);

    return jsonResponse({
      ok: true,
      budget_id: budgetId,
      budget_url: `https://app.orcafascio.com/orc/orcamentos/${budgetId}`,
      valor_alvo_aplicado: valorAlvo,
      trace_id: traceId,
      proximo_passo:
        'Abre o orçamento no Orçafascio pra conferir. Total bate com o alvo; ' +
        'a distribuição interna foi escalada linearmente — itens em branco continuam zerados.',
    });
  } catch (err) {
    if (err instanceof OrcafascioWebError) {
      return errorResponse(502, `Auth Orçafascio falhou: ${err.message}`, { code: err.code });
    }
    if (err instanceof OrcafascioV2023Error) {
      return errorResponse(502, `ajustarValor falhou: ${err.message}`, err.details);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return errorResponse(500, `Erro inesperado: ${msg}`);
  }
});
