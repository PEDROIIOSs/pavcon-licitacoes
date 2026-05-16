// Helper de autenticação no Orçafascio via UI web (Plano B').
//
// Fluxo:
//   1. GET /login/new          → captura CSRF token (meta tag) + cookies pré-auth
//   2. POST /login             → form-urlencoded com authenticity_token + email + password
//   3. Resposta 302 + Set-Cookie _orcafascio_session=<token>
//   4. Cache do cookie em orcafascio_sessoes (auth_token = string completa do cookie)
//
// IMPORTANTE: aqui o `secret_token` é, na verdade, a **senha de login** do
// usuário no Orçafascio. Cadastre a credencial com metadata.auth_type='web'
// pra distinguir das credenciais de API pública (auth_type='api').

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { logIntegration } from './audit.ts';

const ORCAFASCIO_WEB_BASE = 'https://app.orcafascio.com';
const LOGIN_FORM_URL = `${ORCAFASCIO_WEB_BASE}/login/new`;
const LOGIN_SUBMIT_URL = `${ORCAFASCIO_WEB_BASE}/login`;

// Sem Max-Age explícito o cookie é "session" — definimos 4h como TTL prático,
// com margem de 15min antes de relogar.
const SESSION_TTL_HOURS = 4;
const SAFETY_MARGIN_MINUTES = 15;

export interface OrcafascioWebSession {
  /** Cookie "Cookie:" header completo, pronto pra reusar (ex.: "_orcafascio_session=abc; AWSALB=...") */
  cookie_header: string;
  /** Apenas o valor de _orcafascio_session (sem o nome) — útil pra debug */
  session_value: string;
  expires_at: string;
  cached: boolean;
  email: string;
}

export class OrcafascioWebError extends Error {
  constructor(
    public readonly code:
      | 'credential_not_found'
      | 'credential_inactive'
      | 'credential_wrong_provider'
      | 'credential_no_email'
      | 'credential_wrong_auth_type'
      | 'vault_unreadable'
      | 'csrf_not_found'
      | 'login_rejected'
      | 'login_unreachable'
      | 'login_unexpected',
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'OrcafascioWebError';
  }
}

interface CredentialRow {
  id: string;
  owner_id: string | null;
  escopo: 'pessoal' | 'organizacional';
  provider: string;
  vault_secret_id: string;
  metadata: {
    email?: string;
    auth_type?: 'web' | 'api';
    /** Sobrescreve nomes dos campos do form se a v2023+ mudar */
    field_email?: string;
    field_password?: string;
    field_csrf?: string;
  } | null;
  ativo: boolean;
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
  if (error || !data) {
    throw new OrcafascioWebError(
      'credential_not_found',
      'Credencial não encontrada.',
      error?.message,
    );
  }
  if (!data.ativo) {
    throw new OrcafascioWebError('credential_inactive', 'Credencial inativa.');
  }
  if (data.provider !== 'orcafascio') {
    throw new OrcafascioWebError(
      'credential_wrong_provider',
      `Credencial é de provedor "${data.provider}", esperado "orcafascio".`,
    );
  }
  if (data.metadata?.auth_type !== 'web') {
    throw new OrcafascioWebError(
      'credential_wrong_auth_type',
      `Credencial tem auth_type="${data.metadata?.auth_type ?? 'undefined'}", esperado "web". Cadastre uma com metadata.auth_type='web'.`,
    );
  }
  if (data.escopo === 'pessoal' && data.owner_id !== callerUserId) {
    throw new OrcafascioWebError(
      'credential_inactive',
      'Esta credencial pessoal pertence a outro usuário.',
    );
  }
  if (!data.metadata?.email) {
    throw new OrcafascioWebError(
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
    throw new OrcafascioWebError(
      'vault_unreadable',
      'Não foi possível resolver a senha do Vault.',
      error?.message ?? 'segredo ausente',
    );
  }
  return data;
}

/**
 * Parse rudimentar do header Set-Cookie. Como Deno fetch não expõe Set-Cookie
 * em getSetCookie() de forma estável em todas as versões, usamos getAll('set-cookie')
 * via headers.entries() ou getSetCookie() (Deno 1.40+).
 */
function extractSetCookies(headers: Headers): string[] {
  // @ts-expect-error: getSetCookie é experimental mas existe no Deno runtime das Edge Functions
  if (typeof headers.getSetCookie === 'function') {
    // @ts-expect-error
    return headers.getSetCookie();
  }
  // Fallback: get('set-cookie') retorna apenas o primeiro
  const out: string[] = [];
  for (const [k, v] of headers.entries()) {
    if (k.toLowerCase() === 'set-cookie') out.push(v);
  }
  return out;
}

/**
 * Constrói a string `Cookie:` header a partir de um Set-Cookie array,
 * pegando só o pair NAME=VALUE (sem atributos).
 */
function buildCookieHeader(setCookies: string[]): { header: string; sessionValue: string | null } {
  const pairs: string[] = [];
  let sessionValue: string | null = null;
  for (const sc of setCookies) {
    const namePair = sc.split(';')[0].trim();
    if (!namePair) continue;
    pairs.push(namePair);
    if (namePair.startsWith('_orcafascio_session=')) {
      sessionValue = namePair.substring('_orcafascio_session='.length);
    }
  }
  return { header: pairs.join('; '), sessionValue };
}

/** Extrai authenticity_token de um HTML. Tenta meta tag e input hidden. */
function extractCsrfToken(html: string): string | null {
  // <meta name="csrf-token" content="...">
  const meta = html.match(/<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/i);
  if (meta) return meta[1];
  // <input type="hidden" name="authenticity_token" value="...">
  const input = html.match(/name=["']authenticity_token["']\s+value=["']([^"']+)["']/i);
  if (input) return input[1];
  return null;
}

interface LoginAttempt {
  status: number;
  cookieHeader: string;
  sessionValue: string | null;
  location: string | null;
  bodyText: string;
}

async function performLogin(
  email: string,
  password: string,
  fieldEmail: string,
  fieldPassword: string,
): Promise<LoginAttempt> {
  // 1) GET /login/new — pega CSRF + cookies pré-auth
  const formResp = await fetch(LOGIN_FORM_URL, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      'User-Agent': 'pavcon-licitacoes/0.1 (Edge Function orcafascio-web-auth)',
      'Accept': 'text/html,application/xhtml+xml',
    },
  });
  const formHtml = await formResp.text();
  const csrf = extractCsrfToken(formHtml);
  if (!csrf) {
    throw new OrcafascioWebError(
      'csrf_not_found',
      'authenticity_token não encontrado em /login/new.',
      formHtml.slice(0, 300),
    );
  }
  const formCookies = extractSetCookies(formResp.headers);
  const { header: preAuthCookie } = buildCookieHeader(formCookies);

  // 2) POST /login com form-urlencoded
  const params = new URLSearchParams();
  params.set('authenticity_token', csrf);
  params.set(fieldEmail, email);
  params.set(fieldPassword, password);
  params.set('commit', 'Entrar');

  const loginResp = await fetch(LOGIN_SUBMIT_URL, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'User-Agent': 'pavcon-licitacoes/0.1 (Edge Function orcafascio-web-auth)',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'text/html,application/xhtml+xml',
      'Origin': ORCAFASCIO_WEB_BASE,
      'Referer': LOGIN_FORM_URL,
      ...(preAuthCookie ? { Cookie: preAuthCookie } : {}),
    },
    body: params.toString(),
  });

  const bodyText = await loginResp.text();
  const location = loginResp.headers.get('location');
  const setCookies = extractSetCookies(loginResp.headers);
  const { header: postAuthCookie, sessionValue } = buildCookieHeader(setCookies);

  return {
    status: loginResp.status,
    cookieHeader: postAuthCookie,
    sessionValue,
    location,
    bodyText,
  };
}

export async function authenticateOrcafascioWeb(
  admin: SupabaseClient,
  credentialId: string,
  opts: {
    callerUserId: string;
    forceRefresh?: boolean;
    traceId?: string;
    licitacaoId?: string | null;
  },
): Promise<OrcafascioWebSession> {
  const startedAt = Date.now();
  const traceId = opts.traceId ?? crypto.randomUUID();
  const credential = await loadCredential(admin, credentialId, opts.callerUserId);
  const credentialEmail = credential.metadata!.email!;

  // 1) Cache (mesma tabela orcafascio_sessoes — auth_token guarda o Cookie completo)
  if (!opts.forceRefresh) {
    const { data: cached } = await admin.rpc('get_orcafascio_active_session', {
      p_credential_id: credentialId,
    });
    if (Array.isArray(cached) && cached.length > 0) {
      const s = cached[0];
      // Só reaproveita se o token cacheado parece um Cookie (contém '_orcafascio_session=')
      if (s.auth_token.includes('_orcafascio_session=')) {
        return {
          cookie_header: s.auth_token,
          session_value: s.auth_token
            .split(';')
            .map((p: string) => p.trim())
            .find((p: string) => p.startsWith('_orcafascio_session='))
            ?.substring('_orcafascio_session='.length) ?? '',
          expires_at: s.expires_at,
          cached: true,
          email: s.email,
        };
      }
    }
  }

  // 2) Login real
  const password = await readSecret(admin, credential.vault_secret_id);
  const fieldEmail = credential.metadata!.field_email ?? 'email';
  // O form do Orçafascio usa "senha" (português), não "password".
  const fieldPassword = credential.metadata!.field_password ?? 'senha';

  let attempt: LoginAttempt;
  try {
    attempt = await performLogin(credentialEmail, password, fieldEmail, fieldPassword);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logIntegration(admin, {
      user_id: opts.callerUserId,
      licitacao_id: opts.licitacaoId ?? null,
      provider: 'orcafascio',
      endpoint: LOGIN_SUBMIT_URL,
      metodo_http: 'POST',
      request_payload: { email: credentialEmail, password, field_email: fieldEmail, field_password: fieldPassword },
      response_status: null,
      response_payload: { network_error: msg },
      duracao_ms: Date.now() - startedAt,
      trace_id: traceId,
    });
    throw new OrcafascioWebError(
      'login_unreachable',
      'Falha de rede ao logar no Orçafascio.',
      msg,
    );
  }

  await logIntegration(admin, {
    user_id: opts.callerUserId,
    licitacao_id: opts.licitacaoId ?? null,
    provider: 'orcafascio',
    endpoint: LOGIN_SUBMIT_URL,
    metodo_http: 'POST',
    request_payload: {
      email: credentialEmail,
      password,
      field_email: fieldEmail,
      field_password: fieldPassword,
    },
    response_status: attempt.status,
    response_payload: {
      location: attempt.location,
      session_set: !!attempt.sessionValue,
      body_excerpt: attempt.bodyText.slice(0, 200),
    },
    duracao_ms: Date.now() - startedAt,
    trace_id: traceId,
  });

  // Sucesso: 302 + cookie _orcafascio_session no Set-Cookie + Location pra /v2023/...
  const isSuccess = attempt.status === 302 &&
    !!attempt.sessionValue &&
    !!attempt.location &&
    !attempt.location.includes('/login');

  if (!isSuccess) {
    await admin.rpc('invalidate_orcafascio_sessao', { p_credential_id: credentialId });
    if (attempt.status === 200 || (attempt.status === 302 && attempt.location?.includes('/login'))) {
      throw new OrcafascioWebError(
        'login_rejected',
        'Orçafascio rejeitou as credenciais (login retornou pra /login).',
        { status: attempt.status, location: attempt.location, body: attempt.bodyText.slice(0, 200) },
      );
    }
    throw new OrcafascioWebError(
      'login_unexpected',
      `Resposta inesperada do login: ${attempt.status} ${attempt.location ?? ''}.`,
      { status: attempt.status, location: attempt.location, body: attempt.bodyText.slice(0, 200) },
    );
  }

  const expiresAt = new Date(
    Date.now() + (SESSION_TTL_HOURS * 60 - SAFETY_MARGIN_MINUTES) * 60 * 1000,
  ).toISOString();

  // Persiste sessão. Reutilizamos os campos da tabela orcafascio_sessoes:
  //   auth_token              = Cookie header completo
  //   orcafascio_user_id      = "web" (não temos user_id real do Mongo aqui)
  //   orcafascio_company_id   = "web"
  //   email                   = email da credencial
  await admin.rpc('upsert_orcafascio_sessao', {
    p_credential_id: credentialId,
    p_auth_token: attempt.cookieHeader,
    p_orcafascio_user_id: 'web',
    p_orcafascio_company_id: 'web',
    p_orcafascio_department_id: null,
    p_email: credentialEmail,
    p_company_name: null,
    p_expires_at: expiresAt,
  });

  return {
    cookie_header: attempt.cookieHeader,
    session_value: attempt.sessionValue!,
    expires_at: expiresAt,
    cached: false,
    email: credentialEmail,
  };
}

/**
 * Wrapper de fetch pra endpoints internos /v2023/. Injeta Cookie + auditoria.
 * Em caso de 401/302→/login (sessão expirou), invalida o cache.
 */
export async function orcafascioWebFetch(
  admin: SupabaseClient,
  credentialId: string,
  path: string,
  init: RequestInit,
  opts: {
    session: OrcafascioWebSession;
    callerUserId: string;
    licitacaoId?: string | null;
    traceId?: string;
  },
): Promise<{ status: number; json: unknown; text: string; isAuthFailure: boolean }> {
  const url = path.startsWith('http') ? path : `${ORCAFASCIO_WEB_BASE}${path}`;
  const startedAt = Date.now();
  const headers = new Headers(init.headers ?? {});
  headers.set('Cookie', opts.session.cookie_header);
  headers.set('Accept', 'application/vnd.api+json, application/json, */*');
  headers.set('Origin', ORCAFASCIO_WEB_BASE);
  headers.set('Referer', `${ORCAFASCIO_WEB_BASE}/v2023/home`);
  headers.set('X-Requested-With', 'XMLHttpRequest');
  headers.set('User-Agent', 'pavcon-licitacoes/0.1 (Edge Function orcafascio-web)');
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/x-www-form-urlencoded');
  }

  const response = await fetch(url, { ...init, headers, redirect: 'manual' });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  // Sessão expirada: 302 redirect pra /login, ou 401
  const location = response.headers.get('location');
  const isAuthFailure = response.status === 401 ||
    (response.status === 302 && !!location && location.includes('/login'));

  await logIntegration(admin, {
    user_id: opts.callerUserId,
    licitacao_id: opts.licitacaoId ?? null,
    provider: 'orcafascio',
    endpoint: url,
    metodo_http: init.method ?? 'GET',
    request_payload: init.body
      ? { body_excerpt: String(init.body).slice(0, 500) }
      : null,
    response_status: response.status,
    response_payload: json ?? { text: text.slice(0, 500), location },
    duracao_ms: Date.now() - startedAt,
    trace_id: opts.traceId ?? null,
  });

  if (isAuthFailure) {
    await admin.rpc('invalidate_orcafascio_sessao', {
      p_credential_id: credentialId,
    });
  }

  return { status: response.status, json, text, isAuthFailure };
}
