// =============================================================================
// Edge Function: orcafascio-auth
// =============================================================================
// Responsável por obter um auth_token válido do Orçafascio para uma credencial
// registrada em api_credentials. Estratégia:
//
//   1. Valida JWT do chamador (deve ser um usuário autenticado da Pavcon).
//   2. Lê api_credentials e checa autorização (escopo organizacional ou dono).
//   3. Se `force_refresh = false` (default), tenta cache em orcafascio_sessoes
//      via RPC `get_orcafascio_active_session`. Se ainda válido (>5min),
//      devolve sem chamar a API.
//   4. Caso contrário, lê o secret_token do Vault, faz POST em
//      https://api.orcafascio.com/api/v1/login/authenticate_user, salva sessão
//      via RPC `upsert_orcafascio_sessao` e retorna o token.
//   5. Toda chamada externa fica registrada em audit_log_integracoes.
//
// Body esperado (JSON):
//   {
//     "credential_id": "uuid",       // obrigatório
//     "force_refresh": false,        // opcional (default: false)
//     "trace_id": "uuid"             // opcional (correlaciona logs)
//   }
//
// Resposta (200):
//   {
//     "auth_token": "...",
//     "expires_at": "ISO-8601",
//     "cached": true|false,
//     "orcafascio_user_id": "...",
//     "orcafascio_company_id": "...",
//     "orcafascio_department_id": "...",
//     "email": "..."
//   }
// =============================================================================

import { handleCorsPreflight } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/json.ts';
import {
  getServiceRoleClient,
  HttpError,
  requireAuthenticatedUser,
} from '../_shared/supabase.ts';
import { logIntegration } from '../_shared/audit.ts';

const ORCAFASCIO_LOGIN_URL =
  'https://api.orcafascio.com/api/v1/login/authenticate_user';

// Sessão do Orçafascio dura 24h, mas damos margem de segurança.
const SESSION_TTL_HOURS = 24;
const SAFETY_MARGIN_MINUTES = 10;

interface RequestBody {
  credential_id?: string;
  force_refresh?: boolean;
  trace_id?: string;
}

interface OrcafascioLoginResponse {
  // Estrutura inferida; ajustar quando a primeira chamada real revelar o
  // shape exato. Conhecemos os campos pelas colunas de orcafascio_sessoes.
  auth_token?: string;
  token?: string; // possível alias
  user?: {
    _id?: string;
    id?: string;
    email?: string;
  };
  user_id?: string;
  company?: {
    _id?: string;
    id?: string;
    name?: string;
  };
  company_id?: string;
  department?: {
    _id?: string;
    id?: string;
  };
  department_id?: string;
  email?: string;
  [key: string]: unknown;
}

function pick<T>(...candidates: Array<T | undefined>): T | undefined {
  for (const c of candidates) {
    if (c !== undefined && c !== null && c !== '') return c;
  }
  return undefined;
}

Deno.serve(async (req: Request) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;

  if (req.method !== 'POST') {
    return errorResponse(405, 'Método não permitido. Use POST.');
  }

  const startedAt = Date.now();
  const admin = getServiceRoleClient();

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, 'JSON inválido no body da requisição.');
  }

  const credentialId = body.credential_id?.trim();
  const forceRefresh = body.force_refresh === true;
  const traceId = body.trace_id ?? crypto.randomUUID();

  if (!credentialId) {
    return errorResponse(400, 'credential_id é obrigatório.');
  }

  let userId: string | null = null;
  try {
    // ---- 1) Auth do chamador --------------------------------------------------
    const user = await requireAuthenticatedUser(req);
    userId = user.id;

    // ---- 2) Lê credencial + autoriza -----------------------------------------
    const { data: credential, error: credErr } = await admin
      .from('api_credentials')
      .select('id, owner_id, escopo, provider, vault_secret_id, metadata, ativo')
      .eq('id', credentialId)
      .maybeSingle();

    if (credErr) {
      console.error('[orcafascio-auth] erro ao ler credential:', credErr);
      return errorResponse(500, 'Falha ao ler credencial.', credErr.message);
    }
    if (!credential) {
      return errorResponse(404, 'Credencial não encontrada.');
    }
    if (!credential.ativo) {
      return errorResponse(403, 'Credencial inativa.');
    }
    if (credential.provider !== 'orcafascio') {
      return errorResponse(
        400,
        `Credencial é de provedor "${credential.provider}", esperado "orcafascio".`,
      );
    }
    // Autorização: organizacional → qualquer usuário ativo. pessoal → só owner.
    if (credential.escopo === 'pessoal' && credential.owner_id !== userId) {
      return errorResponse(
        403,
        'Esta credencial pessoal pertence a outro usuário.',
      );
    }

    const credentialEmail =
      (credential.metadata as { email?: string } | null)?.email;
    if (!credentialEmail) {
      return errorResponse(
        422,
        'Credencial não tem "email" em metadata. Atualize antes de usar.',
      );
    }

    // ---- 3) Tenta cache ------------------------------------------------------
    if (!forceRefresh) {
      const { data: cached, error: cacheErr } = await admin.rpc(
        'get_orcafascio_active_session',
        { p_credential_id: credentialId },
      );
      if (cacheErr) {
        console.warn('[orcafascio-auth] cache lookup falhou:', cacheErr);
      } else if (Array.isArray(cached) && cached.length > 0) {
        const s = cached[0];
        return jsonResponse({
          auth_token: s.auth_token,
          expires_at: s.expires_at,
          cached: true,
          orcafascio_user_id: s.orcafascio_user_id,
          orcafascio_company_id: s.orcafascio_company_id,
          orcafascio_department_id: s.orcafascio_department_id,
          email: s.email,
        });
      }
    }

    // ---- 4) Busca o secret_token no Vault ------------------------------------
    const { data: secret, error: secretErr } = await admin.rpc(
      'read_vault_secret',
      { p_secret_id: credential.vault_secret_id },
    );
    if (secretErr || typeof secret !== 'string' || !secret) {
      console.error('[orcafascio-auth] falha ao ler vault:', secretErr);
      return errorResponse(
        500,
        'Não foi possível resolver o secret_token do Vault.',
        secretErr?.message ?? 'segredo ausente',
      );
    }

    // ---- 5) Login no Orçafascio ----------------------------------------------
    const loginPayload = {
      email: credentialEmail,
      secret_token: secret,
    };

    let response: Response;
    let responseJson: OrcafascioLoginResponse | null = null;
    let responseText = '';
    try {
      response = await fetch(ORCAFASCIO_LOGIN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'pavcon-licitacoes/0.1 (Edge Function orcafascio-auth)',
        },
        body: JSON.stringify(loginPayload),
      });
      responseText = await response.text();
      try {
        responseJson = JSON.parse(responseText) as OrcafascioLoginResponse;
      } catch {
        responseJson = null;
      }
    } catch (fetchErr) {
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      await logIntegration(admin, {
        user_id: userId,
        provider: 'orcafascio',
        endpoint: ORCAFASCIO_LOGIN_URL,
        metodo_http: 'POST',
        request_payload: loginPayload,
        response_status: null,
        response_payload: { network_error: msg },
        duracao_ms: Date.now() - startedAt,
        trace_id: traceId,
      });
      return errorResponse(502, 'Falha de rede ao falar com o Orçafascio.', msg);
    }

    const duracaoMs = Date.now() - startedAt;

    // ---- 6) Audita a chamada (com mascaramento) ------------------------------
    await logIntegration(admin, {
      user_id: userId,
      provider: 'orcafascio',
      endpoint: ORCAFASCIO_LOGIN_URL,
      metodo_http: 'POST',
      request_payload: loginPayload,
      response_status: response.status,
      response_payload: responseJson ?? { raw: responseText.slice(0, 500) },
      duracao_ms: duracaoMs,
      trace_id: traceId,
    });

    // ---- 7) Tratamento de erro do Orçafascio ---------------------------------
    if (response.status === 401 || response.status === 403) {
      // Credenciais inválidas → invalida cache (defensivo) e devolve 422.
      await admin.rpc('invalidate_orcafascio_sessao', {
        p_credential_id: credentialId,
      });
      return errorResponse(
        422,
        'Orçafascio rejeitou as credenciais. Verifique email e secret_token.',
        responseJson ?? responseText.slice(0, 200),
      );
    }
    if (!response.ok) {
      return errorResponse(
        502,
        `Orçafascio respondeu ${response.status}.`,
        responseJson ?? responseText.slice(0, 200),
      );
    }

    if (!responseJson) {
      return errorResponse(
        502,
        'Resposta do Orçafascio não é JSON válido.',
        responseText.slice(0, 200),
      );
    }

    // ---- 8) Extrai campos (com fallbacks) ------------------------------------
    const authToken = pick(responseJson.auth_token, responseJson.token);
    const orcafascioUserId = pick(
      responseJson.user?._id,
      responseJson.user?.id,
      responseJson.user_id,
    );
    const orcafascioCompanyId = pick(
      responseJson.company?._id,
      responseJson.company?.id,
      responseJson.company_id,
    );
    const orcafascioDepartmentId = pick(
      responseJson.department?._id,
      responseJson.department?.id,
      responseJson.department_id,
    );
    const email = pick(responseJson.user?.email, responseJson.email) ??
      credentialEmail;
    const companyName = responseJson.company?.name ?? null;

    if (!authToken || !orcafascioUserId || !orcafascioCompanyId) {
      return errorResponse(
        502,
        'Resposta do Orçafascio sem auth_token / user / company esperados.',
        {
          received_keys: Object.keys(responseJson),
        },
      );
    }

    const expiresAt = new Date(
      Date.now() + (SESSION_TTL_HOURS * 60 - SAFETY_MARGIN_MINUTES) * 60 * 1000,
    ).toISOString();

    // ---- 9) Persiste sessão --------------------------------------------------
    const { error: upsertErr } = await admin.rpc('upsert_orcafascio_sessao', {
      p_credential_id: credentialId,
      p_auth_token: authToken,
      p_orcafascio_user_id: orcafascioUserId,
      p_orcafascio_company_id: orcafascioCompanyId,
      p_orcafascio_department_id: orcafascioDepartmentId ?? null,
      p_email: email,
      p_company_name: companyName,
      p_expires_at: expiresAt,
    });
    if (upsertErr) {
      console.error('[orcafascio-auth] upsert_orcafascio_sessao falhou:', upsertErr);
      // Devolve o token mesmo assim — login funcionou, mas o cache falhou.
    }

    return jsonResponse({
      auth_token: authToken,
      expires_at: expiresAt,
      cached: false,
      orcafascio_user_id: orcafascioUserId,
      orcafascio_company_id: orcafascioCompanyId,
      orcafascio_department_id: orcafascioDepartmentId ?? null,
      email,
      company_name: companyName,
      trace_id: traceId,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return errorResponse(err.status, err.message, err.details);
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[orcafascio-auth] erro inesperado:', err);
    return errorResponse(500, 'Erro inesperado.', msg);
  }
});
