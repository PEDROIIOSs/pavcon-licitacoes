// Probe parte 2: tenta POST em /base/mybase/* com payload deliberadamente
// inválido pra descobrir:
//   - Se o endpoint POST existe (404 vs 422)
//   - Quais campos são required (mensagem de erro do servidor)
//
// Uso: ORCAFASCIO_EMAIL=... ORCAFASCIO_SECRET=... node scripts/probe-orcafascio-post.mjs

const EMAIL = process.env.ORCAFASCIO_EMAIL;
const SECRET = process.env.ORCAFASCIO_SECRET;
if (!EMAIL || !SECRET) {
  console.error('Faltam ORCAFASCIO_EMAIL e/ou ORCAFASCIO_SECRET');
  process.exit(1);
}
const BASE = 'https://api.orcafascio.com/api/v1';
const UA = 'pavcon-licitacoes/0.1 (probe-post)';

async function req(method, path, headers = {}, body = null) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const init = {
    method,
    headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
  };
  if (body) init.body = body;
  const t0 = Date.now();
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, dt: Date.now() - t0, json, text };
}

// Login
const login = await req('POST', '/login/authenticate_user',
  { 'Content-Type': 'application/json' },
  JSON.stringify({ email: EMAIL, secret_token: SECRET }),
);
const authToken = login.json?.auth_token;
if (!authToken) {
  console.error('Login falhou:', login.status, login.text);
  process.exit(2);
}
console.log('Login OK. company_id:', login.json.user.company_id);

const auth = { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' };

const POSTS_TO_PROBE = [
  // Payload deliberadamente vazio — esperamos 422 (validation error) se o endpoint existe
  { path: '/base/mybase/resources', body: {} },
  { path: '/base/mybase/compositions', body: {} },
  { path: '/base/mybase/groups', body: {} },
  // Variações
  { path: '/base/mybase/resources/', body: {} },
];

for (const p of POSTS_TO_PROBE) {
  const r = await req('POST', p.path, auth, JSON.stringify(p.body));
  const symbol = r.status === 422 ? '✓ EXISTE (422 validation)'
    : r.status === 200 || r.status === 201 ? '⚠ CRIOU ALGO (cancelar mental)'
    : r.status === 404 ? '✗ não existe'
    : r.status === 405 ? '⊘ método não aceito'
    : r.status === 400 ? '? bad request'
    : `? ${r.status}`;
  console.log(`POST ${p.path.padEnd(40)} → ${symbol}`);
  if (r.json) {
    const sample = JSON.stringify(r.json).slice(0, 400);
    console.log(`     resp: ${sample}`);
  } else if (r.text) {
    console.log(`     raw:  ${r.text.slice(0, 200)}`);
  }
}

// Também: PUT/PATCH em recurso conhecido (READ-ONLY: usamos ID inválido pra forçar 404)
console.log('\nProbando PUT/PATCH com ID inválido (testa se o método existe):');
const FAKE_ID = '000000000000000000000000';
for (const m of ['PUT', 'PATCH', 'DELETE']) {
  for (const path of [
    `/base/mybase/resources/${FAKE_ID}`,
    `/base/mybase/compositions/${FAKE_ID}`,
  ]) {
    const r = await req(m, path, auth, m === 'DELETE' ? null : JSON.stringify({}));
    const symbol = r.status === 404 ? '? 404 (id ou endpoint não existe)'
      : r.status === 422 ? '✓ existe (422 validation)'
      : r.status === 405 ? '⊘ método não aceito'
      : `? ${r.status}`;
    console.log(`${m.padEnd(7)} ${path} → ${symbol}`);
    if (r.text) console.log(`     ${r.text.slice(0, 150)}`);
  }
}
