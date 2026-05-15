// Teste controlado: cria 1 grupo + 1 insumo + 1 composição no MyBase
// do Orçafascio com prefixo "TESTE_PAVCON_" pra ser fácil identificar e apagar.
// No final imprime os IDs criados + um script de cleanup.
//
// Uso: ORCAFASCIO_EMAIL=... ORCAFASCIO_SECRET=... node scripts/test-orcafascio-create.mjs

const EMAIL = process.env.ORCAFASCIO_EMAIL;
const SECRET = process.env.ORCAFASCIO_SECRET;
const BASE = 'https://api.orcafascio.com/api/v1';
const UA = 'pavcon-licitacoes/0.1 (test-create)';

// Suffix com timestamp pra deixar único e fácil identificar:
const RUN = `TESTE_PAVCON_${Date.now()}`;
console.log(`Identificador deste teste: ${RUN}\n`);

async function req(method, path, body = null, headers = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': UA,
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let j = null;
  try { j = text ? JSON.parse(text) : null; } catch {}
  return { status: r.status, json: j, text };
}

// 1) Login
const loginResp = await fetch(`${BASE}/login/authenticate_user`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, secret_token: SECRET }),
});
const login = await loginResp.json();
const authToken = login.auth_token;
console.log('✓ Login OK\n');

const createdIds = { groups: [], resources: [], compositions: [] };

// =============================================================================
// 1. CRIAR GRUPO
// =============================================================================
console.log('=== 1. POST /base/mybase/groups ===');
const grp = await req('POST', '/base/mybase/groups', {
  Descricao: `${RUN}_grupo`,
});
console.log(`   status: ${grp.status}`);
console.log(`   resp:   ${JSON.stringify(grp.json).slice(0, 300)}`);
if (grp.status === 200 || grp.status === 201) {
  const id = grp.json.id ?? grp.json._id;
  if (id) {
    createdIds.groups.push(id);
    console.log(`   ✓ grupo criado: ${id}`);
  }
}

// =============================================================================
// 2. CRIAR INSUMO (RESOURCE)
// =============================================================================
console.log('\n=== 2. POST /base/mybase/resources ===');
console.log('--- 2a. Payload mínimo com Tipo=1 ---');
const resAttempt1 = await req('POST', '/base/mybase/resources', {
  Codigo: `${RUN}_R1`,
  Descricao: `${RUN}_resource (apagar)`,
  Tipo: 1,
  Unidade: 'Un',
});
console.log(`   status: ${resAttempt1.status}`);
console.log(`   resp:   ${JSON.stringify(resAttempt1.json).slice(0, 400)}`);

if (resAttempt1.status === 200 || resAttempt1.status === 201) {
  const id = resAttempt1.json.id ?? resAttempt1.json._id;
  createdIds.resources.push(id);
  console.log(`   ✓ resource criado: ${id}`);
} else if (resAttempt1.status === 422) {
  // 422 = endpoint existe mas validation falhou. Vamos ver o que falta:
  console.log('   ⚠ validation. Tentando com mais campos...');
  console.log('--- 2b. Tentando incluir Locals com preço ---');
  const resAttempt2 = await req('POST', '/base/mybase/resources', {
    Codigo: `${RUN}_R1`,
    Descricao: `${RUN}_resource (apagar)`,
    Tipo: 1,
    Unidade: 'Un',
    Locals: { PI: { pnd: 100, pd: 100, pndi: 100, pdi: 100 } },
  });
  console.log(`   status: ${resAttempt2.status}`);
  console.log(`   resp:   ${JSON.stringify(resAttempt2.json).slice(0, 400)}`);
  if (resAttempt2.status === 200 || resAttempt2.status === 201) {
    const id = resAttempt2.json.id ?? resAttempt2.json._id;
    createdIds.resources.push(id);
    console.log(`   ✓ resource criado: ${id}`);
  }
}

// =============================================================================
// 3. CRIAR COMPOSIÇÃO
// =============================================================================
console.log('\n=== 3. POST /base/mybase/compositions ===');
// Tipo varia. Pelas composições existentes vimos "PARE". Vamos testar.
console.log('--- 3a. Payload mínimo com Tipo="PARE" ---');
const compAttempt1 = await req('POST', '/base/mybase/compositions', {
  Codigo: `${RUN}_C1`,
  Descricao: `${RUN}_composition (apagar)`,
  Tipo: 'PARE',
  Unidade: 'Un',
});
console.log(`   status: ${compAttempt1.status}`);
console.log(`   resp:   ${JSON.stringify(compAttempt1.json).slice(0, 400)}`);
let compositionId = null;
if (compAttempt1.status === 200 || compAttempt1.status === 201) {
  compositionId = compAttempt1.json.id ?? compAttempt1.json._id;
  createdIds.compositions.push(compositionId);
  console.log(`   ✓ composition criada: ${compositionId}`);
}

// 3b. Se tivermos resource_id E composition_id, tentar adicionar item à composição
//     via diferentes paths possíveis pra descobrir o que existe.
if (compositionId && createdIds.resources.length > 0) {
  const resourceId = createdIds.resources[0];
  console.log(`\n--- 3b. Testando como adicionar item (resource=${resourceId}) à composição ---`);
  // Tentar via PUT na própria composição
  const putAttempt = await req('PUT', `/base/mybase/compositions/${compositionId}`, {
    items: [{ resource_id: resourceId, coefficient: 1.5 }],
  });
  console.log(`   PUT composition with items: ${putAttempt.status}`);
  console.log(`   resp: ${JSON.stringify(putAttempt.json).slice(0, 300)}`);

  // Tentar via PATCH
  const patchAttempt = await req('PATCH', `/base/mybase/compositions/${compositionId}`, {
    items: [{ resource_id: resourceId, coefficient: 1.5 }],
  });
  console.log(`   PATCH composition with items: ${patchAttempt.status}`);
  console.log(`   resp: ${JSON.stringify(patchAttempt.json).slice(0, 300)}`);

  // Re-fetch pra ver se algum dos updates pegou
  const refresh = await req('GET', `/base/mybase/compositions/${compositionId}`);
  console.log(`   Composition após updates: ${JSON.stringify(refresh.json).slice(0, 500)}`);
}

// =============================================================================
// 4. RESUMO + CLEANUP
// =============================================================================
console.log('\n========================================');
console.log('RECURSOS CRIADOS NO ORÇAFASCIO:');
console.log('========================================');
console.log(JSON.stringify(createdIds, null, 2));

console.log('\n========================================');
console.log('PRA APAGAR DEPOIS, RODE:');
console.log('========================================');
console.log('node scripts/test-orcafascio-cleanup.mjs');
console.log('com o conteúdo criado abaixo (ou peça pro Claude rodar):');
console.log(`\nCREATED_IDS=${JSON.stringify(createdIds)}`);
