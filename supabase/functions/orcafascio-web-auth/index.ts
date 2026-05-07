// =============================================================================
// Edge Function: orcafascio-web-auth (Plano B' — autenticação via UI web)
// =============================================================================
// Wrapper sobre _shared/orcafascio-web.ts:authenticateOrcafascioWeb. Existe
// pra que o frontend (e outras Edge Functions) consigam um Cookie-header válido
// pra falar com endpoints /v2023/* do Orçafascio.
//
// Body (JSON):
//   {
//     "credential_id": "uuid",       // obrigatório (provider=orcafascio + metadata.auth_type=web)
//     "force_refresh": false,        // opcional
//     "trace_id": "uuid"             // opcional
//   }
//
// Resposta 200:
//   {
//     "cookie_header": "_orcafascio_session=...; AWSALB=...",
//     "session_value": "...",   // só o valor de _orcafascio_session
//     "expires_at": "ISO-8601",
//     "cached": true|false,
//     "email": "..."
//   }
//
// Diferente da orcafascio-auth: aqui o secret no Vault é a SENHA de login.
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

interface RequestBody {
  credential_id?: string;
  force_refresh?: boolean;
  trace_id?: string;
}

const ERR_TO_HTTP: Record<OrcafascioWebError['code'], number> = {
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
    return errorResponse(405, 'Método não permitido. Use POST.');
  }

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, 'JSON inválido no body.');
  }

  const credentialId = body.credential_id?.trim();
  if (!credentialId) {
    return errorResponse(400, 'credential_id é obrigatório.');
  }

  try {
    const user = await requireAuthenticatedUser(req);
    const session = await authenticateOrcafascioWeb(
      getServiceRoleClient(),
      credentialId,
      {
        callerUserId: user.id,
        forceRefresh: body.force_refresh === true,
        traceId: body.trace_id,
      },
    );
    // Não devolvemos o cookie header completo em produção (vaza segredo).
    // Só metadata: caller usa o credential_id pra outra Edge Function fazer fetch.
    return jsonResponse({
      ok: true,
      cached: session.cached,
      expires_at: session.expires_at,
      email: session.email,
      // session_value é só pra debug — pode tirar depois
      session_value_preview: session.session_value.slice(0, 8) + '…',
    });
  } catch (err) {
    if (err instanceof OrcafascioWebError) {
      return errorResponse(ERR_TO_HTTP[err.code], err.message, err.details);
    }
    if (err instanceof HttpError) {
      return errorResponse(err.status, err.message, err.details);
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[orcafascio-web-auth] erro inesperado:', err);
    return errorResponse(500, 'Erro inesperado.', msg);
  }
});
