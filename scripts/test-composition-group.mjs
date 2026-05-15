// Testa se POST /base/mybase/compositions aceita group_id pra colocar a composição dentro de uma pasta.

const EMAIL = 'licitacao@pavconconstrutora.com.br';
const SECRET = process.env.ORCAFASCIO_SECRET;
const BASE = 'https://api.orcafascio.com/api/v1';

async function login() {
  const r = await fetch(`${BASE}/login/authenticate_user`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, secret_token: SECRET }),
  });
  const j = await r.json();
  return j.auth_token;
}

const token = await login();
console.log('Login OK');

const headers = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  Accept: 'application/json',
};

// 1) Cria pasta
const grpResp = await fetch(`${BASE}/base/mybase/groups`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ description: 'TESTE_GROUP_ID_DEBUG' }),
});
const grp = await grpResp.json();
console.log(`Grupo criado: ${grp.id}`);

// 2) Tenta criar composition COM group_id
console.log('\n=== Tentativa 2A: POST compositions COM group_id ===');
const c1 = await fetch(`${BASE}/base/mybase/compositions`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    code: 'TEST_GRP_001',
    second_code: '',
    description: 'TESTE composition com group_id',
    labor: false,
    type: 'PARE',
    unit: 'Un',
    local: 'PI',
    is_sicro: false,
    rounding_type: 2,
    note: '',
    group_id: grp.id,  // ← testar se aceita
  }),
});
const c1json = await c1.json();
console.log(`  status: ${c1.status}`);
console.log(`  resp: ${JSON.stringify(c1json).slice(0, 500)}`);

// 3) Confirma se o group_id foi salvo
if (c1json.id) {
  const getR = await fetch(`${BASE}/base/mybase/compositions/${c1json.id}`, { headers });
  const got = await getR.json();
  console.log(`\n=== GET composition criada ===`);
  console.log(`  group_id no GET: ${got.group_id ?? '(não tem campo group_id)'}`);
  console.log(`  full: ${JSON.stringify(got).slice(0, 400)}`);

  // Cleanup
  await fetch(`${BASE}/base/mybase/compositions/${c1json.id}`, { method: 'DELETE', headers });
  console.log(`  composition apagada`);
}

// 4) Alternativa: tenta com "group" ao invés de "group_id"
console.log('\n=== Tentativa 2B: POST compositions com "group" (singular) ===');
const c2 = await fetch(`${BASE}/base/mybase/compositions`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    code: 'TEST_GRP_002',
    second_code: '',
    description: 'TESTE composition com group',
    labor: false,
    type: 'PARE',
    unit: 'Un',
    local: 'PI',
    is_sicro: false,
    rounding_type: 2,
    note: '',
    group: grp.id,
  }),
});
const c2json = await c2.json();
console.log(`  status: ${c2.status}`);
console.log(`  resp keys: ${c2json ? Object.keys(c2json).join(',') : 'null'}`);
if (c2json.id) {
  const getR = await fetch(`${BASE}/base/mybase/compositions/${c2json.id}`, { headers });
  const got = await getR.json();
  console.log(`  group_id retornado: ${got.group_id ?? 'null'}`);
  await fetch(`${BASE}/base/mybase/compositions/${c2json.id}`, { method: 'DELETE', headers });
}

// Cleanup grupo
await fetch(`${BASE}/base/mybase/groups/${grp.id}`, { method: 'DELETE', headers });
console.log(`\nGrupo apagado.`);
