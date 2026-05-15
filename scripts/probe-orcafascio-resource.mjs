// Descobre payload de RESOURCE. Já sabemos que groups usa flat lowercase.
// Provavelmente resources também — só preciso achar os nomes EXATOS.

const EMAIL = process.env.ORCAFASCIO_EMAIL;
const SECRET = process.env.ORCAFASCIO_SECRET;
const BASE = 'https://api.orcafascio.com/api/v1';

const login = await fetch(`${BASE}/login/authenticate_user`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, secret_token: SECRET }),
});
const authToken = (await login.json()).auth_token;

async function tryPost(path, payload, label) {
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
  console.log(`  ${(ok ? '✓' : `${r.status}`).padEnd(5)} ${label}`);
  if (j && !ok) {
    const errs = j.errors ?? j;
    console.log(`        err: ${JSON.stringify(errs).slice(0, 250)}`);
  }
  if (ok) console.log(`        id: ${j.id}`);
  return { status: r.status, json: j, ok };
}

async function cleanup(type, id) {
  const path = type === 'resource' ? `/base/mybase/resources/${id}`
    : type === 'composition' ? `/base/mybase/compositions/${id}`
    : `/base/mybase/groups/${id}`;
  await fetch(`${BASE}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${authToken}` },
  });
}

const ts = Date.now();

// Resources existentes têm: code, description, type:4, unit, locals.PI.{pnd,pd,pndi,pdi}
// O sample mostrou unit: "m²", type: 4 (numérico)
console.log('=== RESOURCES — payloads candidatos ===');
const candidates = [
  {
    label: 'flat lowercase EN + unidade PT',
    payload: { code: `R${ts}a`, description: 'TEST', type: 1, unidade: 'Un' },
  },
  {
    label: 'flat lowercase EN com unit',
    payload: { code: `R${ts}b`, description: 'TEST', type: 1, unit: 'Un' },
  },
  {
    label: 'flat com tipo string',
    payload: { code: `R${ts}c`, description: 'TEST', type: 'INSUMO', unit: 'Un' },
  },
  {
    label: 'flat PT minúsculas',
    payload: { codigo: `R${ts}d`, descricao: 'TEST', tipo: 1, unidade: 'Un' },
  },
  {
    label: 'mix EN+PT (description+codigo+tipo+unidade)',
    payload: { codigo: `R${ts}e`, description: 'TEST', tipo: 1, unidade: 'Un' },
  },
  {
    label: 'lowercase EN com locals',
    payload: {
      code: `R${ts}f`,
      description: 'TEST',
      type: 1,
      unit: 'Un',
      locals: { PI: { pnd: 100, pd: 100 } },
    },
  },
];

const created = [];
for (const c of candidates) {
  const r = await tryPost('/base/mybase/resources', c.payload, c.label);
  if (r.ok) {
    created.push({ type: 'resource', id: r.json.id });
    break;
  }
}

console.log('\n=== COMPOSITIONS — payloads candidatos ===');
const compCandidates = [
  {
    label: 'flat lowercase EN com type=PARE',
    payload: { code: `C${ts}a`, description: 'TEST', type: 'PARE', unit: 'Un' },
  },
  {
    label: 'flat com unidade PT',
    payload: { code: `C${ts}b`, description: 'TEST', type: 'PARE', unidade: 'Un' },
  },
  {
    label: 'flat PT all',
    payload: { codigo: `C${ts}c`, descricao: 'TEST', tipo: 'PARE', unidade: 'Un' },
  },
];
for (const c of compCandidates) {
  const r = await tryPost('/base/mybase/compositions', c.payload, c.label);
  if (r.ok) {
    created.push({ type: 'composition', id: r.json.id });
    break;
  }
}

console.log('\n=== Limpando ===');
for (const c of created) {
  await cleanup(c.type, c.id);
  console.log(`  DELETE ${c.type} ${c.id}`);
}
