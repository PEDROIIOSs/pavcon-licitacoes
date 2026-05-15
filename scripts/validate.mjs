// Validação rápida pós-`supabase db push`. Conta linhas em cada tabela
// esperada e bate o número total contra o que a migration deveria criar.
// Uso: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/validate.mjs

const URL = process.env.SUPABASE_URL;
const SR = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !SR) {
  console.error('Faltam SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY no env.');
  process.exit(1);
}

const TABLES = [
  'profiles',
  'api_credentials',
  'orcafascio_sessoes',
  'orcafascio_grupos_cache',
  'orcafascio_orcamentos_cache',
  'licitacoes',
  'licitacao_arquivos',
  'extracoes_ocr',
  'composicoes_extraidas',
  'composicao_propria_itens',
  'analises_historicas',
  'composicoes_edital_sincronizadas',
  'notificacoes',
  'audit_log_integracoes',
];

async function tableCount(name) {
  const res = await fetch(`${URL}/rest/v1/${name}?select=*`, {
    method: 'HEAD',
    headers: {
      apikey: SR,
      Authorization: `Bearer ${SR}`,
      Prefer: 'count=exact',
      Range: '0-0',
    },
  });
  if (!res.ok) {
    return { name, ok: false, status: res.status, error: await res.text() };
  }
  const range = res.headers.get('content-range') ?? '';
  const total = range.split('/')[1] ?? '?';
  return { name, ok: true, total: Number.parseInt(total, 10) };
}

async function rpcExists(name, args) {
  const res = await fetch(`${URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: SR,
      Authorization: `Bearer ${SR}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  // Sucesso (200) ou 4xx que NÃO seja 404 = função existe
  return { name, status: res.status, exists: res.status !== 404 };
}

async function callOrcafascioAuthUnauthenticated() {
  const res = await fetch(`${URL}/functions/v1/orcafascio-auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential_id: '00000000-0000-0000-0000-000000000000' }),
  });
  return { status: res.status, body: await res.text() };
}

console.log('=== Tabelas ===');
const tableResults = await Promise.all(TABLES.map(tableCount));
let okCount = 0;
for (const r of tableResults) {
  if (r.ok) {
    console.log(`  ✓ ${r.name.padEnd(34)} ${r.total} linhas`);
    okCount++;
  } else {
    console.log(`  ✗ ${r.name.padEnd(34)} HTTP ${r.status}`);
  }
}
console.log(`\nTotal: ${okCount}/${TABLES.length} tabelas acessíveis`);

console.log('\n=== RPCs (helpers da Edge Function) ===');
const rpcs = await Promise.all([
  rpcExists('read_vault_secret', { p_secret_id: '00000000-0000-0000-0000-000000000000' }),
  rpcExists('upsert_orcafascio_sessao', {
    p_credential_id: '00000000-0000-0000-0000-000000000000',
    p_auth_token: 'x',
    p_orcafascio_user_id: 'x',
    p_orcafascio_company_id: 'x',
    p_orcafascio_department_id: null,
    p_email: 'x@x',
    p_company_name: null,
    p_expires_at: '2026-01-01T00:00:00Z',
  }),
  rpcExists('invalidate_orcafascio_sessao', { p_credential_id: '00000000-0000-0000-0000-000000000000' }),
  rpcExists('get_orcafascio_active_session', { p_credential_id: '00000000-0000-0000-0000-000000000000' }),
  rpcExists('get_orcafascio_token', { p_credential_id: '00000000-0000-0000-0000-000000000000' }),
]);
for (const r of rpcs) {
  const symbol = r.exists ? '✓' : '✗';
  console.log(`  ${symbol} ${r.name.padEnd(34)} HTTP ${r.status}`);
}

console.log('\n=== Edge Functions deployadas (sem JWT, esperando 401) ===');
const FUNCTIONS = [
  'orcafascio-auth',
  'orcafascio-web-auth',
  'orcafascio-sync-grupos',
  'extracao-edital',
  'orcafascio-cadastrar-edital',
];
for (const name of FUNCTIONS) {
  const res = await fetch(`${URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const symbol = res.status === 401 ? '✓' : '?';
  console.log(`  ${symbol} ${name.padEnd(32)} HTTP ${res.status}`);
}
