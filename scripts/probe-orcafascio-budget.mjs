// Probe parte 3: caçar o endpoint de orçamento (budget) na API pública.
// Uso: ORCAFASCIO_EMAIL=... ORCAFASCIO_SECRET=... node scripts/probe-orcafascio-budget.mjs

const EMAIL = process.env.ORCAFASCIO_EMAIL;
const SECRET = process.env.ORCAFASCIO_SECRET;
const BASE = 'https://api.orcafascio.com/api/v1';
const UA = 'pavcon-licitacoes/0.1 (probe-budget)';

async function req(method, path, body = null) {
  const r = await fetch(path.startsWith('http') ? path : `${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': UA,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let j = null;
  try { j = text ? JSON.parse(text) : null; } catch {}
  return { status: r.status, json: j, text };
}

const login = await fetch(`${BASE}/login/authenticate_user`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, secret_token: SECRET }),
});
const authToken = (await login.json()).auth_token;

const PATHS = [
  // Variações sob /base/mybase/
  '/base/mybase/budget',
  '/base/mybase/budgets',
  '/base/mybase/orcamento',
  '/base/mybase/orcamentos',
  '/base/mybase/proposal',
  '/base/mybase/proposals',
  '/base/mybase/proposta',
  '/base/mybase/propostas',
  '/base/mybase/quote',
  '/base/mybase/quotes',
  // Outros prefixos
  '/budgets',
  '/budget',
  '/orcamentos',
  '/orcamento',
  '/bud/budgets',
  '/bud/budget',
  '/proposals',
  '/proposal',
  '/quotes',
  // Sem /api/v1 (raiz da API)
  'https://api.orcafascio.com/budgets',
  'https://api.orcafascio.com/api/budgets',
  'https://api.orcafascio.com/api/v2/budgets',
  // Padrões REST
  '/base/mybase/budgets/new',
  // Estado do user
  '/base/mybase',
  '/base',
  '/help',
  '/v1',
];

console.log('=== Probing GET em caminhos alternativos ===');
for (const p of PATHS) {
  const r = await req('GET', p);
  const symbol = r.status === 200 ? '✓ EXISTE'
    : r.status === 401 || r.status === 403 ? '🔒 AUTH'
    : r.status === 404 ? '✗'
    : r.status === 405 ? '⊘ method'
    : `? ${r.status}`;
  console.log(`  GET ${p.padEnd(55)} → ${symbol}`);
  if (r.status === 200 && r.json) {
    console.log(`       sample: ${JSON.stringify(r.json).slice(0, 250)}`);
  } else if (r.status >= 400 && r.status < 500 && r.json && r.status !== 404 && r.status !== 401) {
    console.log(`       resp: ${JSON.stringify(r.json).slice(0, 150)}`);
  }
}

console.log('\n=== Probing POST com {} pra ver se é "endpoint existe mas validation" ===');
for (const p of [
  '/base/mybase/budgets',
  '/base/mybase/budget',
  '/base/mybase/orcamentos',
  '/base/mybase/proposals',
  '/base/mybase/propostas',
]) {
  const r = await req('POST', p, {});
  const symbol = r.status === 422 ? '✓ EXISTE'
    : r.status === 404 ? '✗'
    : r.status === 405 ? '⊘'
    : `? ${r.status}`;
  console.log(`  POST ${p.padEnd(55)} → ${symbol}`);
  if (r.status >= 400 && r.json) {
    console.log(`       resp: ${JSON.stringify(r.json).slice(0, 200)}`);
  }
}

console.log('\n=== Probing dentro de uma composição existente (pra ver itens/items) ===');
// Pega o id da primeira composição
const comps = await req('GET', '/base/mybase/compositions?per_page=1');
const firstCompId = comps.json?.records?.[0]?.id;
if (firstCompId) {
  console.log(`Usando composition id de teste: ${firstCompId}`);
  for (const p of [
    `/base/mybase/compositions/${firstCompId}`,
    `/base/mybase/compositions/${firstCompId}/items`,
    `/base/mybase/compositions/${firstCompId}/resources`,
    `/base/mybase/compositions/${firstCompId}/composition_items`,
  ]) {
    const r = await req('GET', p);
    console.log(`  GET ${p.padEnd(80)} → ${r.status}`);
    if (r.status === 200 && r.json) {
      console.log(`       sample: ${JSON.stringify(r.json).slice(0, 300)}`);
    }
  }
}
