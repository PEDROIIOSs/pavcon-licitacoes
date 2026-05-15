// Inspeciona o shape COMPLETO de uma composition + um resource + um group
// pra entender a estrutura da API.
//
// Uso: ORCAFASCIO_EMAIL=... ORCAFASCIO_SECRET=... node scripts/probe-orcafascio-inspect.mjs

const EMAIL = process.env.ORCAFASCIO_EMAIL;
const SECRET = process.env.ORCAFASCIO_SECRET;
const BASE = 'https://api.orcafascio.com/api/v1';
const UA = 'pavcon-licitacoes/0.1 (probe-inspect)';

const login = await fetch(`${BASE}/login/authenticate_user`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, secret_token: SECRET }),
});
const authToken = (await login.json()).auth_token;

async function getJson(path) {
  const r = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${authToken}`, Accept: 'application/json', 'User-Agent': UA },
  });
  return await r.json();
}

console.log('=== 1 composition completa ===');
const list = await getJson('/base/mybase/compositions?per_page=1');
console.log(JSON.stringify(list.records[0], null, 2));

console.log('\n=== 1 resource completo ===');
const resList = await getJson('/base/mybase/resources?per_page=1');
console.log(JSON.stringify(resList.records[0], null, 2));

console.log('\n=== 1 group completo ===');
const grpList = await getJson('/base/mybase/groups?per_page=1');
console.log(JSON.stringify(grpList.records[0], null, 2));

console.log('\n=== Paginação fields ===');
console.log({
  composition_meta: { total: list.total, per_page: list.per_page, current_page: list.current_page, keys: Object.keys(list) },
});
