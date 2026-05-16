// Admin client (service_role) — bypassa RLS.
// Usar APENAS em Server Actions ou Route Handlers (NUNCA em Client Components).
// O service_role key NÃO pode ser exposto ao browser.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '@/lib/env';

// Tipo permissivo enquanto não geramos schema do banco com supabase gen types.
// Aceita any table/row — dá responsabilidade ao chamador de mandar shape certa.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any, 'public', any>;

let adminClient: AnyClient | null = null;

export function createAdminClient(): AnyClient {
  if (adminClient) return adminClient;
  adminClient = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  ) as AnyClient;
  return adminClient;
}
