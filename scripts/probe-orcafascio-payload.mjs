// Descobre o formato CORRETO do payload pra POST.
// A API retorna fields lowercase em GET (description, code, type, unit)
// mas erros em PT capitalizado (Descricao, Codigo, Tipo, Unidade).
// Provavelmente quer payload aninhado estilo Rails.
//
// Uso: ORCAFASCIO_EMAIL=... ORCAFASCIO_SECRET=... node scripts/probe-orcafascio-payload.mjs

const EMAIL = process.env.ORCAFASCIO_EMAIL;
const SECRET = process.env.ORCAFASCIO_SECRET;
const BASE = 'https://api.orcafascio.com/api/v1';

const loginResp = await fetch(`${BASE}/login/authenticate_user`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, secret_token: SECRET }),
});
const authToken = (await loginResp.json()).auth_token;

async function tryCreate(path, payload, label) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  const ok = r.status === 200 || r.status === 201;
  const symbol = ok ? '✓ CRIOU' : r.status === 422 ? '⚠ 422' : `? ${r.status}`;
  console.log(`  ${symbol.padEnd(11)} ${label}`);
  if (j && !ok) console.log(`    err: ${JSON.stringify(j).slice(0, 300)}`);
  if (j && ok) console.log(`    id:  ${j.id ?? j._id ?? '?'}`);
  return { status: r.status, json: j, ok };
}

const ts = Date.now();
const created = [];

console.log('=== GROUPS — variações de payload ===');
const groupAttempts = [
  { label: 'flat: {Descricao}',         payload: { Descricao: `TEST_${ts}_a` } },
  { label: 'flat: {descricao}',         payload: { descricao: `TEST_${ts}_b` } },
  { label: 'flat: {description}',       payload: { description: `TEST_${ts}_c` } },
  { label: 'wrap: {group:{Descricao}}', payload: { group: { Descricao: `TEST_${ts}_d` } } },
  { label: 'wrap: {group:{descricao}}', payload: { group: { descricao: `TEST_${ts}_e` } } },
  { label: 'wrap:{group:{description}}', payload: { group: { description: `TEST_${ts}_f` } } },
  { label: 'wrap: {data:{description}}', payload: { data: { description: `TEST_${ts}_g` } } },
];
for (const a of groupAttempts) {
  const r = await tryCreate('/base/mybase/groups', a.payload, a.label);
  if (r.ok) {
    const id = r.json.id ?? r.json._id;
    if (id) created.push({ type: 'group', id });
    break; // achou o formato — para
  }
}

console.log('\n=== RESOURCES — só se groups funcionou ===');
if (created.length > 0) {
  const resAttempts = [
    {
      label: 'wrap: {resource:{code,description,type,unit}}',
      payload: { resource: { code: `R${ts}`, description: `TEST_${ts}_res`, type: 1, unit: 'Un' } },
    },
    {
      label: 'wrap: {resource:{Codigo,Descricao,Tipo,Unidade}}',
      payload: { resource: { Codigo: `R${ts}b`, Descricao: `TEST_${ts}_res`, Tipo: 1, Unidade: 'Un' } },
    },
  ];
  for (const a of resAttempts) {
    const r = await tryCreate('/base/mybase/resources', a.payload, a.label);
    if (r.ok) {
      const id = r.json.id ?? r.json._id;
      if (id) created.push({ type: 'resource', id });
      break;
    }
  }
} else {
  console.log('   (pulado — groups não funcionou)');
}

console.log('\n=== COMPOSITIONS — só se groups funcionou ===');
if (created.find((x) => x.type === 'group')) {
  const compAttempts = [
    {
      label: 'wrap: {composition:{code,description,type,unit}}',
      payload: { composition: { code: `C${ts}`, description: `TEST_${ts}_comp`, type: 'PARE', unit: 'Un' } },
    },
  ];
  for (const a of compAttempts) {
    const r = await tryCreate('/base/mybase/compositions', a.payload, a.label);
    if (r.ok) {
      const id = r.json.id ?? r.json._id;
      if (id) created.push({ type: 'composition', id });
      break;
    }
  }
}

console.log('\n========================================');
console.log('CRIADO ATÉ AGORA:');
console.log(JSON.stringify(created, null, 2));

// Cleanup automático imediato
if (created.length > 0) {
  console.log('\n========================================');
  console.log('Limpando recursos de teste...');
  for (const c of created) {
    const path = c.type === 'group' ? `/base/mybase/groups/${c.id}`
      : c.type === 'resource' ? `/base/mybase/resources/${c.id}`
      : `/base/mybase/compositions/${c.id}`;
    const r = await fetch(`${BASE}${path}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authToken}` },
    });
    console.log(`  DELETE ${path} → ${r.status}`);
  }
}
