// Sabemos que code/description/type são aceitos. Falta achar como passar a unidade.
// Resources existentes têm: code, description, type:4, unit:"m²", locals:{PI:{pnd,pd}}

const EMAIL = process.env.ORCAFASCIO_EMAIL;
const SECRET = process.env.ORCAFASCIO_SECRET;
const BASE = 'https://api.orcafascio.com/api/v1';

const login = await fetch(`${BASE}/login/authenticate_user`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, secret_token: SECRET }),
});
const authToken = (await login.json()).auth_token;

async function tryPost(payload, label) {
  const r = await fetch(`${BASE}/base/mybase/resources`, {
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
  const ok = r.status >= 200 && r.status < 300;
  console.log(`  ${(ok ? '✓' : `${r.status}`).padEnd(5)} ${label}`);
  if (j) console.log(`        ${JSON.stringify(j).slice(0, 280)}`);
  else if (t) console.log(`        text: ${t.slice(0, 200)}`);
  return { status: r.status, json: j, ok };
}

const ts = Date.now();
const created = [];

// shape do GET completo
const candidates = [
  {
    label: 'shape EXATA do GET (code/description/type:4/unit/locals/status)',
    payload: {
      code: `R${ts}_g`,
      second_code: '',
      description: 'TEST_PAVCON',
      type: 4,
      unit: 'Un',
      locals: { PI: { pnd: 100, pd: 100, pndi: 100, pdi: 100 } },
      status: true,
      note: '',
    },
  },
  {
    label: 'mesma shape SEM locals',
    payload: {
      code: `R${ts}_h`,
      description: 'TEST_PAVCON',
      type: 4,
      unit: 'Un',
      status: true,
    },
  },
  {
    label: 'só os 4 obrigatórios + locals',
    payload: {
      code: `R${ts}_i`,
      description: 'TEST_PAVCON',
      type: 4,
      unit: 'Un',
      locals: { PI: { pnd: 0, pd: 0 } },
    },
  },
  {
    label: 'shape simples sem status/locals',
    payload: {
      code: `R${ts}_j`,
      description: 'TEST_PAVCON',
      type: 4,
      unit: 'Un',
    },
  },
];

for (const c of candidates) {
  const r = await tryPost(c.payload, c.label);
  if (r.ok) {
    created.push(r.json.id);
  }
}

// Cleanup
console.log('\n=== Limpando ===');
for (const id of created) {
  const r = await fetch(`${BASE}/base/mybase/resources/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${authToken}` },
  });
  console.log(`  DELETE resource ${id} → ${r.status}`);
}
