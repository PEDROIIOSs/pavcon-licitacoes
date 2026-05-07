// =============================================================================
// Edge Function: orcafascio-auth
// =============================================================================
// Wrapper fino sobre `_shared/orcafascio.ts:authenticateOrcafascio`. Existe
// para que o frontend ou outras Edge Functions possam pedir um auth_token
// válido sem replicar a lógica de cache + login.
//
// Body (JSON):
//   {
//     "credential_id": "uuid",       // obrigatório
//     "force_refresh": false,        // opcional
//     "trace_id": "uuid"             // opcional
//   }
//
// Resposta 200:
//   {
//     "auth_token": "...",
//     "expires_at": "ISO-8601",
//     "cached": true|false,
//     "orcafascio_user_id": "...",
//     "orcafascio_company_id": "...",
//     "orcafascio_department_id": "...",
//     "email": "...",
//     "company_name": "..."
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

interface RequestBody {
  credential_id?: string;
  force_refresh?: boolean;
  trace_id?: string;
}

const ERR_TO_HTTP: Record<OrcafascioAuthError['code'], number> = {
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

  const credentialId = body.credential_id?.trim();
  if (!credentialId) {
    return errorResponse(400, 'credential_id é obrigatório.');
  }

  try {
    const user = await requireAuthenticatedUser(req);
    const session = await authenticateOrcafascio(
      getServiceRoleClient(),
      credentialId,
      {
        callerUserId: user.id,
        forceRefresh: body.force_refresh === true,
        traceId: body.trace_id,
      },
    );
    return jsonResponse(session);
  } catch (err) {
    if (err instanceof OrcafascioAuthError) {
      return errorResponse(ERR_TO_HTTP[err.code], err.message, err.details);
    }
    if (err instanceof HttpError) {
      return errorResponse(err.status, err.message, err.details);
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[orcafascio-auth] erro inesperado:', err);
    return errorResponse(500, 'Erro inesperado.', msg);
  }
});
