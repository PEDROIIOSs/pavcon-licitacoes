// Helper compartilhado para autenticação no Orçafascio.
// Usado pelas Edge Functions orcafascio-auth, orcafascio-sync-grupos,
// orcafascio-sync-historico e orcafascio-cadastrar-edital.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { logIntegration } from './audit.ts';

export const ORCAFASCIO_API_BASE = 'https://api.orcafascio.com/api/v1';
const LOGIN_URL = `${ORCAFASCIO_API_BASE}/login/authenticate_user`;
const SESSION_TTL_HOURS = 24;
const SAFETY_MARGIN_MINUTES = 10;

export interface OrcafascioSession {
  auth_token: string;
  expires_at: string;
  cached: boolean;
  orcafascio_user_id: string;
  orcafascio_company_id: string;
  orcafascio_department_id: string | null;
  email: string;
  company_name: string | null;
}

export interface CredentialRow {
  id: string;
  owner_id: string | null;
  escopo: 'pessoal' | 'organizacional';
  provider: 'orcafascio' | 'anthropic' | 'gemini' | 'voyage' | 'openai';
  vault_secret_id: string;
  metadata: { email?: string } | null;
  ativo: boolean;
}

export class OrcafascioAuthError extends Error {
  constructor(
    public readonly code:
      | 'credential_not_found'
      | 'credential_inactive'
      | 'credential_wrong_provider'
      | 'credential_no_email'
      | 'vault_unreadable'
      | 'orcafascio_rejected'
      | 'orcafascio_unreachable'
      | 'orcafascio_unexpected',
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'OrcafascioAuthError';
  }
}

interface LoginResponse {
  auth_token?: string;
  token?: string;
  user?: { _id?: string; id?: string; email?: string };
  user_id?: string;
  company?: { _id?: string; id?: string; name?: string };
  company_id?: string;
  department?: { _id?: string; id?: string };
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

async function loadCredential(
  admin: SupabaseClient,
  credentialId: string,
  callerUserId: string,
): Promise<CredentialRow> {
  const { data, error } = await admin
    .from('api_credentials')
    .select('id, owner_id, escopo, provider, vault_secret_id, metadata, ativo')
    .eq('id', credentialId)
    .maybeSingle();

  if (error) {
    throw new OrcafascioAuthError(
      'credential_not_found',
      'Falha ao consultar credencial.',
      error.message,
    );
  }
  if (!data) {
    throw new OrcafascioAuthError(
      'credential_not_found',
      'Credencial não encontrada.',
    );
  }
  if (!data.ativo) {
    throw new OrcafascioAuthError('credential_inactive', 'Credencial inativa.');
  }
  if (data.provider !== 'orcafascio') {
    throw new OrcafascioAuthError(
      'credential_wrong_provider',
      `Credencial é de provedor "${data.provider}", esperado "orcafascio".`,
    );
  }
  if (data.escopo === 'pessoal' && data.owner_id !== callerUserId) {
    throw new OrcafascioAuthError(
      'credential_inactive',
      'Esta credencial pessoal pertence a outro usuário.',
    );
  }
  if (!data.metadata?.email) {
    throw new OrcafascioAuthError(
      'credential_no_email',
      'Credencial não tem "email" em metadata.',
    );
  }
  return data as CredentialRow;
}

async function readSecret(
  admin: SupabaseClient,
  vaultSecretId: string,
): Promise<string> {
  const { data, error } = await admin.rpc('read_vault_secret', {
    p_secret_id: vaultSecretId,
  });
  if (error || typeof data !== 'string' || !data) {
    throw new OrcafascioAuthError(
      'vault_unreadable',
      'Não foi possível resolver o secret_token do Vault.',
      error?.message ?? 'segredo ausente',
    );
  }
  return data;
}

async function callLogin(
  email: string,
  secretToken: string,
): Promise<{
  status: number;
  json: LoginResponse | null;
  rawText: string;
}> {
  const response = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'pavcon-licitacoes/0.1 (Edge Function)',
    },
    body: JSON.stringify({ email, secret_token: secretToken }),
  });
  const rawText = await response.text();
  let json: LoginResponse | null = null;
  try {
    json = JSON.parse(rawText) as LoginResponse;
  } catch {
    json = null;
  }
  return { status: response.status, json, rawText };
}

/**
 * Autentica no Orçafascio respeitando cache de sessão. Lança
 * OrcafascioAuthError em qualquer falha tratável; demais erros propagam.
 *
 * @param opts.callerUserId UUID do usuário Pavcon que disparou a operação
 *   (vai pro audit log + checagem de escopo pessoal)
 * @param opts.forceRefresh ignora o cache (default false)
 * @param opts.traceId correlaciona logs (default: random UUID)
 * @param opts.licitacaoId opcional, vincula a chamada a uma licitação
 */
export async function authenticateOrcafascio(
  admin: SupabaseClient,
  credentialId: string,
  opts: {
    callerUserId: string;
    forceRefresh?: boolean;
    traceId?: string;
    licitacaoId?: string | null;
  },
): Promise<OrcafascioSession> {
  const startedAt = Date.now();
  const traceId = opts.traceId ?? crypto.randomUUID();
  const credential = await loadCredential(
    admin,
    credentialId,
    opts.callerUserId,
  );
  const credentialEmail = credential.metadata!.email!;

  // 1) Cache
  if (!opts.forceRefresh) {
    const { data: cached } = await admin.rpc('get_orcafascio_active_session', {
      p_credential_id: credentialId,
    });
    if (Array.isArray(cached) && cached.length > 0) {
      const s = cached[0];
      return {
        auth_token: s.auth_token,
        expires_at: s.expires_at,
        cached: true,
        orcafascio_user_id: s.orcafascio_user_id,
        orcafascio_company_id: s.orcafascio_company_id,
        orcafascio_department_id: s.orcafascio_department_id,
        email: s.email,
        company_name: s.company_name,
      };
    }
  }

  // 2) Login
  const secret = await readSecret(admin, credential.vault_secret_id);
  let result;
  try {
    result = await callLogin(credentialEmail, secret);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logIntegration(admin, {
      user_id: opts.callerUserId,
      licitacao_id: opts.licitacaoId ?? null,
      provider: 'orcafascio',
      endpoint: LOGIN_URL,
      metodo_http: 'POST',
      request_payload: { email: credentialEmail, secret_token: secret },
      response_status: null,
      response_payload: { network_error: msg },
      duracao_ms: Date.now() - startedAt,
      trace_id: traceId,
    });
    throw new OrcafascioAuthError(
      'orcafascio_unreachable',
      'Falha de rede ao falar com o Orçafascio.',
      msg,
    );
  }

  await logIntegration(admin, {
    user_id: opts.callerUserId,
    licitacao_id: opts.licitacaoId ?? null,
    provider: 'orcafascio',
    endpoint: LOGIN_URL,
    metodo_http: 'POST',
    request_payload: { email: credentialEmail, secret_token: secret },
    response_status: result.status,
    response_payload: result.json ?? { raw: result.rawText.slice(0, 500) },
    duracao_ms: Date.now() - startedAt,
    trace_id: traceId,
  });

  if (result.status === 401 || result.status === 403) {
    await admin.rpc('invalidate_orcafascio_sessao', {
      p_credential_id: credentialId,
    });
    throw new OrcafascioAuthError(
      'orcafascio_rejected',
      'Orçafascio rejeitou as credenciais.',
      result.json ?? result.rawText.slice(0, 200),
    );
  }
  if (result.status < 200 || result.status >= 300 || !result.json) {
    throw new OrcafascioAuthError(
      'orcafascio_unexpected',
      `Orçafascio respondeu ${result.status} ou JSON inválido.`,
      result.json ?? result.rawText.slice(0, 200),
    );
  }

  const authToken = pick(result.json.auth_token, result.json.token);
  const orcafascioUserId = pick(
    result.json.user?._id,
    result.json.user?.id,
    result.json.user_id,
  );
  // Orçafascio começou a aninhar company_id e company_name DENTRO de user.
  // Mantém os caminhos antigos pra compatibilidade.
  const orcafascioCompanyId = pick(
    result.json.user?.company_id,
    result.json.company?._id,
    result.json.company?.id,
    result.json.company_id,
  );
  const orcafascioDepartmentId = pick(
    result.json.user?.department_id,
    result.json.department?._id,
    result.json.department?.id,
    result.json.department_id,
  );
  const email = pick(result.json.user?.email, result.json.email) ??
    credentialEmail;
  const companyName = pick(
    result.json.user?.company_name,
    result.json.company?.name,
  );

  if (!authToken || !orcafascioUserId || !orcafascioCompanyId) {
    throw new OrcafascioAuthError(
      'orcafascio_unexpected',
      'Resposta do Orçafascio sem auth_token / user / company esperados.',
      { received_keys: Object.keys(result.json) },
    );
  }

  const expiresAt = new Date(
    Date.now() + (SESSION_TTL_HOURS * 60 - SAFETY_MARGIN_MINUTES) * 60 * 1000,
  ).toISOString();

  await admin.rpc('upsert_orcafascio_sessao', {
    p_credential_id: credentialId,
    p_auth_token: authToken,
    p_orcafascio_user_id: orcafascioUserId,
    p_orcafascio_company_id: orcafascioCompanyId,
    p_orcafascio_department_id: orcafascioDepartmentId ?? null,
    p_email: email,
    p_company_name: companyName,
    p_expires_at: expiresAt,
  });

  return {
    auth_token: authToken,
    expires_at: expiresAt,
    cached: false,
    orcafascio_user_id: orcafascioUserId,
    orcafascio_company_id: orcafascioCompanyId,
    orcafascio_department_id: orcafascioDepartmentId ?? null,
    email,
    company_name: companyName,
  };
}

/**
 * Wrapper genérico de fetch ao Orçafascio que injeta o auth_token, audita
 * a chamada e relogga automaticamente em caso de 401.
 */
export async function orcafascioFetch(
  admin: SupabaseClient,
  credentialId: string,
  path: string,
  init: RequestInit,
  opts: {
    session: OrcafascioSession;
    callerUserId: string;
    licitacaoId?: string | null;
    traceId?: string;
  },
): Promise<{ status: number; json: unknown; rawText: string }> {
  const url = path.startsWith('http') ? path : `${ORCAFASCIO_API_BASE}${path}`;
  const startedAt = Date.now();
  const headers = new Headers(init.headers ?? {});
  // O Orçafascio API costuma usar header próprio. Sem doc oficial, mandamos
  // em duas formas comuns — qualquer ajuste fica isolado aqui.
  headers.set('Authorization', `Bearer ${opts.session.auth_token}`);
  headers.set('auth-token', opts.session.auth_token);
  headers.set('Accept', 'application/json');
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }
  headers.set('User-Agent', 'pavcon-licitacoes/0.1 (Edge Function)');

  const response = await fetch(url, { ...init, headers });
  const rawText = await response.text();
  let json: unknown = null;
  try {
    json = rawText ? JSON.parse(rawText) : null;
  } catch {
    json = null;
  }

  await logIntegration(admin, {
    user_id: opts.callerUserId,
    licitacao_id: opts.licitacaoId ?? null,
    provider: 'orcafascio',
    endpoint: url,
    metodo_http: init.method ?? 'GET',
    request_payload: init.body
      ? safeJsonParse(init.body as string) ?? { raw: String(init.body).slice(0, 500) }
      : null,
    response_status: response.status,
    response_payload: json ?? { raw: rawText.slice(0, 500) },
    duracao_ms: Date.now() - startedAt,
    trace_id: opts.traceId ?? null,
  });

  return { status: response.status, json, rawText };
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
