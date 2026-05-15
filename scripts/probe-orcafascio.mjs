// Probe da API pública do Orçafascio. Descobre quais endpoints existem
// e quais HTTP methods aceitam. Roda só GETs e OPTIONS — sem side effects.
//
// Uso:
//   ORCAFASCIO_EMAIL=... ORCAFASCIO_SECRET=... node scripts/probe-orcafascio.mjs
//
// NUNCA hardcode credenciais aqui. Sempre via env var.

const EMAIL = process.env.ORCAFASCIO_EMAIL;
const SECRET = process.env.ORCAFASCIO_SECRET;
if (!EMAIL || !SECRET) {
  console.error('Faltam ORCAFASCIO_EMAIL e/ou ORCAFASCIO_SECRET no env.');
  process.exit(1);
}

const BASE = 'https://api.orcafascio.com/api/v1';
const UA = 'pavcon-licitacoes/0.1 (probe)';

function maskJwt(v) {
  if (typeof v !== 'string' || !v.includes('.')) return String(v).slice(0, 12) + '…';
  const parts = v.split('.');
  return parts.map((p, i) => i === parts.length - 1 ? p.slice(0, 6) + '…' : p.slice(0, 10) + '…').join('.');
}

async function tryRequest(method, path, headers = {}, body = null) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const init = {
    method,
    headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
  };
  if (body) init.body = body;
  const t0 = Date.now();
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    const dt = Date.now() - t0;
    return { ok: true, status: res.status, dt, json, text, headers: Object.fromEntries(res.headers.entries()) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

console.log('========================================');
console.log('Tentativa 1: secret_token como AUTH BEARER (sem login)');
console.log('========================================');

const directBearer = await tryRequest('GET', '/base/mybase/groups', {
  Authorization: `Bearer ${SECRET}`,
});
console.log(`GET /base/mybase/groups   → ${directBearer.status} (${directBearer.dt}ms)`);
if (directBearer.status === 200) {
  console.log('   ✓ Token usado direto funciona! Estrutura da resposta:');
  console.log('   ' + JSON.stringify(directBearer.json).slice(0, 300));
}

console.log('\n========================================');
console.log('Tentativa 2: POST /login/authenticate_user com {email, secret_token}');
console.log('========================================');

const loginResp = await tryRequest('POST', '/login/authenticate_user',
  { 'Content-Type': 'application/json' },
  JSON.stringify({ email: EMAIL, secret_token: SECRET }),
);
console.log(`POST /login/authenticate_user → ${loginResp.status} (${loginResp.dt}ms)`);
if (loginResp.json) {
  console.log('   Keys do JSON:', Object.keys(loginResp.json).join(', '));
  console.log('   Sample:', JSON.stringify(loginResp.json).slice(0, 400));
}
if (loginResp.text && !loginResp.json) {
  console.log('   raw text:', loginResp.text.slice(0, 200));
}

// Escolher o token efetivo
let effectiveToken = null;
let viaLogin = false;
if (loginResp.status === 200 && loginResp.json) {
  const j = loginResp.json;
  effectiveToken = j.auth_token ?? j.token ?? j.access_token ?? j.data?.auth_token;
  if (effectiveToken) {
    viaLogin = true;
    console.log(`   → auth_token obtido via login: ${maskJwt(effectiveToken)}`);
  }
}
if (!effectiveToken && directBearer.status === 200) {
  effectiveToken = SECRET;
  console.log('   → usando secret_token direto como Bearer');
}
if (!effectiveToken) {
  console.error('\n❌ Não consegui auth. Encerrando.');
  process.exit(2);
}

console.log('\n========================================');
console.log(`Tentativa 3: Probing de endpoints com ${viaLogin ? 'auth_token' : 'secret_token'} via Bearer`);
console.log('========================================');

const ENDPOINTS_TO_PROBE = [
  // Conhecidos
  { method: 'GET', path: '/base/mybase/groups', note: 'grupos/pastas' },
  // Orçamentos — vários nomes possíveis
  { method: 'GET', path: '/budgets', note: 'orçamentos (en)' },
  { method: 'GET', path: '/orcamentos', note: 'orçamentos (pt)' },
  { method: 'GET', path: '/bud/budgets', note: 'orçamentos sob /bud' },
  { method: 'GET', path: '/base/mybase/budgets', note: 'orçamentos sob mybase' },
  // Recursos / insumos
  { method: 'GET', path: '/base/mybase/resources', note: 'insumos próprios' },
  { method: 'GET', path: '/resources', note: 'recursos (raiz)' },
  { method: 'GET', path: '/resources/find_by_code?code=SINAPI_88245', note: 'lookup recurso por código' },
  // Composições
  { method: 'GET', path: '/base/mybase/compositions', note: 'composições próprias' },
  { method: 'GET', path: '/compositions', note: 'composições raiz' },
  // Bases (SINAPI, SEINFRA, etc)
  { method: 'GET', path: '/base/bases', note: 'lista de bases' },
  { method: 'GET', path: '/bases', note: 'bases (alt)' },
  // Self / user
  { method: 'GET', path: '/me', note: 'perfil atual' },
  { method: 'GET', path: '/users/me', note: 'perfil atual alt' },
  // Possíveis endpoints de criação (só OPTIONS pra ver Allow)
  { method: 'OPTIONS', path: '/budgets', note: 'OPTIONS budgets' },
  { method: 'OPTIONS', path: '/orcamentos', note: 'OPTIONS orcamentos' },
  { method: 'OPTIONS', path: '/base/mybase/budgets', note: 'OPTIONS mybase/budgets' },
  { method: 'OPTIONS', path: '/base/mybase/resources', note: 'OPTIONS mybase/resources' },
  { method: 'OPTIONS', path: '/base/mybase/compositions', note: 'OPTIONS mybase/compositions' },
];

const results = [];
for (const e of ENDPOINTS_TO_PROBE) {
  const r = await tryRequest(e.method, e.path, {
    Authorization: `Bearer ${effectiveToken}`,
  });
  const allow = r.headers?.['allow'] ?? r.headers?.['access-control-allow-methods'] ?? '';
  const statusSymbol = r.status >= 200 && r.status < 300 ? '✓'
    : r.status === 401 || r.status === 403 ? '🔒'
    : r.status === 404 ? '✗'
    : r.status === 405 ? '⊘'
    : '?';
  console.log(
    `  ${statusSymbol} ${e.method.padEnd(7)} ${e.path.padEnd(50)} → ${r.status}` +
    (allow ? ` [Allow: ${allow}]` : '') +
    `  // ${e.note}`,
  );
  results.push({ ...e, status: r.status, allow });
  // Pra endpoints que existem, mostra estrutura do retorno
  if (r.status === 200 && r.json && e.method === 'GET') {
    const sample = JSON.stringify(r.json).slice(0, 200);
    console.log(`         sample: ${sample}`);
  }
}

console.log('\n========================================');
console.log('RESUMO — endpoints com status 200 OK:');
console.log('========================================');
for (const r of results) {
  if (r.status === 200) {
    console.log(`  ${r.method.padEnd(7)} ${r.path.padEnd(50)}  // ${r.note}`);
  }
}

console.log('\n========================================');
console.log('ENDPOINTS COM 405 (existem mas method errado):');
console.log('========================================');
for (const r of results) {
  if (r.status === 405) {
    console.log(`  ${r.method.padEnd(7)} ${r.path.padEnd(50)}  [Allow: ${r.allow}]`);
  }
}
