// Debug: reproduz a chamada cadastrar-edital fora da Edge Function pra
// identificar onde quebra. Usa o secret_token direto (env var) sem passar pelo Vault.

const EMAIL = 'licitacao@pavconconstrutora.com.br';
const SECRET = process.env.ORCAFASCIO_SECRET;
if (!SECRET) {
  console.error('Faltam ORCAFASCIO_SECRET no env.');
  process.exit(1);
}

const BASE = 'https://api.orcafascio.com/api/v1';

// 1) Login
console.log('=== 1) Login ===');
const loginResp = await fetch(`${BASE}/login/authenticate_user`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, secret_token: SECRET }),
});
const loginText = await loginResp.text();
console.log(`  status ${loginResp.status}`);
const loginJson = JSON.parse(loginText);
const authToken = loginJson.auth_token;
console.log(`  auth_token: ${authToken.slice(0, 20)}…`);

// Helper para fetch igual ao da Edge Function
async function ofFetch(method, path, body) {
  const headers = new Headers();
  headers.set('Authorization', `Bearer ${authToken}`);
  headers.set('auth-token', authToken);
  headers.set('Accept', 'application/json');
  if (body) headers.set('Content-Type', 'application/json');
  headers.set('User-Agent', 'pavcon-licitacoes/0.1 (debug)');

  const r = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, text: t };
}

// 2) Cria grupo (mesma chamada da Edge Function)
console.log('\n=== 2) POST /base/mybase/groups ===');
const grupoDescricao = 'EDITAL / d2359b58 / Picos / PI';
const r2 = await ofFetch('POST', '/base/mybase/groups', { description: grupoDescricao });
console.log(`  status ${r2.status}`);
console.log(`  resp:   ${JSON.stringify(r2.json).slice(0, 300)}`);
if (r2.status < 200 || r2.status >= 300) {
  console.error('  ✗ FALHOU AQUI');
  process.exit(2);
}
const grupoId = r2.json.id;
console.log(`  grupo criado: ${grupoId}`);

// 3) Cria composição (mesma chamada da Edge Function)
console.log('\n=== 3) POST /base/mybase/compositions ===');
const r3 = await ofFetch('POST', '/base/mybase/compositions', {
  code: 'TEST_DEBUG_001',
  second_code: 'LICITACAO_d2359b58',
  description: 'TEST_DEBUG - composição própria do edital. Item 1.1.',
  labor: false,
  type: 'PARE',
  unit: 'MÊS',
  local: 'PI',
  is_sicro: false,
  note: 'Composição extraída do edital. Item 1.1.',
  rounding_type: 2,
});
console.log(`  status ${r3.status}`);
console.log(`  resp:   ${JSON.stringify(r3.json).slice(0, 400)}`);

// 4) Limpa (delete) o grupo e composition criados pra teste
if (r3.status >= 200 && r3.status < 300) {
  await ofFetch('DELETE', `/base/mybase/compositions/${r3.json.id}`);
  console.log('  composition criada — deletada');
}
await ofFetch('DELETE', `/base/mybase/groups/${grupoId}`);
console.log('  grupo deletado');
