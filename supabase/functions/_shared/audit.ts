// Helper para registrar chamadas a APIs externas em audit_log_integracoes.
// Mascarando segredos (tokens, senhas) antes de persistir.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

export type CredentialProvider =
  | 'orcafascio'
  | 'anthropic'
  | 'gemini'
  | 'voyage'
  | 'openai';

export interface AuditEntry {
  user_id?: string | null;
  licitacao_id?: string | null;
  provider: CredentialProvider;
  endpoint: string;
  metodo_http: string;
  request_payload?: unknown;
  response_status?: number | null;
  response_payload?: unknown;
  duracao_ms?: number | null;
  custo_usd?: number | null;
  trace_id?: string | null;
}

const SECRET_KEYS = new Set([
  'secret_token',
  'auth_token',
  'token',
  'password',
  'senha',
  'api_key',
  'authorization',
]);

export function maskSecrets<T>(payload: T): T {
  if (payload == null) return payload;
  if (Array.isArray(payload)) {
    return payload.map((item) => maskSecrets(item)) as unknown as T;
  }
  if (typeof payload === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
      if (SECRET_KEYS.has(k.toLowerCase())) {
        out[k] = typeof v === 'string' && v.length > 8
          ? `***${v.slice(-4)}`
          : '***';
      } else {
        out[k] = maskSecrets(v);
      }
    }
    return out as T;
  }
  return payload;
}

export async function logIntegration(
  admin: SupabaseClient,
  entry: AuditEntry,
): Promise<void> {
  const safeEntry = {
    ...entry,
    request_payload: entry.request_payload
      ? maskSecrets(entry.request_payload)
      : null,
    response_payload: entry.response_payload
      ? maskSecrets(entry.response_payload)
      : null,
  };

  const { error } = await admin
    .from('audit_log_integracoes')
    .insert(safeEntry);

  if (error) {
    // Não derruba a Edge Function por falha de auditoria — só registra.
    console.error('[audit] falhou ao gravar audit_log_integracoes:', error);
  }
}
