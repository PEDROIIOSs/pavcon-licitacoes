// Roda o fluxo orcafascio-cadastrar-orcamento END-TO-END localmente
// (sem passar pela Edge Function), pra ter visibilidade total e debugar.
//
// Replica a lógica do supabase/functions/orcafascio-cadastrar-orcamento/index.ts
// usando o secret_token + senha diretos.

const EMAIL = 'licitacao@pavconconstrutora.com.br';
const SENHA = process.env.ORCAFASCIO_SENHA;
const PAT = process.env.SUPABASE_PAT;
const PROJECT_REF = 'cwgjjjlyccgivscngzgz';
const LICITACAO_ID = process.env.LICITACAO_ID;

if (!SENHA || !PAT || !LICITACAO_ID) {
  console.error('Faltam: ORCAFASCIO_SENHA, SUPABASE_PAT, LICITACAO_ID');
  process.exit(1);
}

const BASE = 'https://app.orcafascio.com';
const SUPA = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

async function sql(query) {
  const r = await fetch(SUPA, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`SQL ${r.status}: ${t}`);
  return JSON.parse(t);
}

// =====================================================================
// 1. Login web
// =====================================================================
console.log('1/9) Login web no Orçafascio...');
const loginFormResp = await fetch(`${BASE}/login/new`, { method: 'GET', redirect: 'manual' });
const loginHtml = await loginFormResp.text();
const csrfM = loginHtml.match(/<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/i);
if (!csrfM) throw new Error('CSRF não encontrado em /login/new');
const initialCsrf = csrfM[1];
const initialCookies = loginFormResp.headers.getSetCookie?.() ?? [];
const initialCookieHeader = initialCookies.map((c) => c.split(';')[0]).join('; ');

const loginParams = new URLSearchParams();
loginParams.set('authenticity_token', initialCsrf);
loginParams.set('email', EMAIL);
loginParams.set('senha', SENHA);     // ← campo "senha" (PT), não "password"
loginParams.set('commit', 'Entrar');

const loginResp = await fetch(`${BASE}/login`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    Cookie: initialCookieHeader,
    Origin: BASE,
    Referer: `${BASE}/login/new`,
    'User-Agent': 'test-cadastrar-orcamento',
  },
  body: loginParams.toString(),
  redirect: 'manual',
});

if (loginResp.status !== 302) {
  throw new Error(`Login falhou: ${loginResp.status} ${await loginResp.text()}`);
}
const loginCookies = loginResp.headers.getSetCookie?.() ?? [];
const cookieHeader = loginCookies.map((c) => c.split(';')[0]).join('; ');
const sessionCookie = loginCookies.find((c) => c.startsWith('_orcafascio_session='));
if (!sessionCookie) throw new Error('Sessão não retornada');
console.log(`   ✓ Sessão obtida (Location: ${loginResp.headers.get('location')})`);

// =====================================================================
// 2. CSRF token autenticado
// =====================================================================
console.log('\n2/9) Buscando CSRF token autenticado...');
const formResp = await fetch(`${BASE}/orc/orcamentos/new`, {
  method: 'GET',
  headers: { Cookie: cookieHeader, 'User-Agent': 'test' },
  redirect: 'manual',
});
const formHtml = await formResp.text();
const csrf2M = formHtml.match(/<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/i);
if (!csrf2M) throw new Error('CSRF (autenticado) não achado');
const CSRF = csrf2M[1];
console.log(`   ✓ CSRF: ${CSRF.slice(0, 20)}…`);

// =====================================================================
// Helper postForm
// =====================================================================
async function postForm(path, formData, label) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const body = new URLSearchParams({ authenticity_token: CSRF, ...formData });
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Cookie: cookieHeader,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/vnd.api+json, application/json, text/html, */*',
      Origin: BASE,
      Referer: `${BASE}/orc/orcamentos`,
      'User-Agent': 'test',
    },
    body: body.toString(),
    redirect: 'manual',
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  if (r.status === 302 || r.status === 303) {
    return { status: r.status, location: r.headers.get('location'), json, text };
  }
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`${label} → ${r.status}: ${text.slice(0, 400)}`);
  }
  return { status: r.status, json, text };
}

// =====================================================================
// 3. Lê dados da licitação
// =====================================================================
console.log('\n3/9) Carregando licitação + composições...');
const lic = (await sql(`SELECT id, titulo, numero_edital, municipio, uf, status, bdi_referencia_edital FROM licitacoes WHERE id='${LICITACAO_ID}'`))[0];
if (!lic) throw new Error('Licitação não encontrada');
console.log(`   título: ${lic.titulo.slice(0, 60)}…`);
console.log(`   status: ${lic.status}`);

// Reset status se necessário
const ALLOWED = ['aguardando_revisao_humana', 'criando_composicoes_edital', 'criando_orcamento_base', 'fase1_concluida'];
if (!ALLOWED.includes(lic.status)) {
  await sql(`UPDATE licitacoes SET status='erro' WHERE id='${LICITACAO_ID}'`);
  await sql(`UPDATE licitacoes SET status='aguardando_revisao_humana' WHERE id='${LICITACAO_ID}'`);
  console.log(`   ✓ Resetada pra aguardando_revisao_humana`);
}

const extr = (await sql(`SELECT json_corrigido, json_extraido FROM extracoes_ocr WHERE licitacao_id='${LICITACAO_ID}' AND status IN ('sucesso','revisada_humano') ORDER BY created_at DESC LIMIT 1`))[0];
const j = extr?.json_corrigido ?? extr?.json_extraido;
const cab = j?.cabecalho ?? null;
const bdi = Number(cab?.bdi_percentual ?? lic.bdi_referencia_edital ?? 22);
const leis = Number(cab?.leis_sociais_percentual ?? 113.78);

const comps = await sql(`SELECT item_codigo, item_nivel, item_pai_codigo, tipo_linha, codigo, fonte, descricao, quantidade, orcafascio_composition_id, ordem FROM composicoes_extraidas WHERE licitacao_id='${LICITACAO_ID}' ORDER BY ordem ASC`);
console.log(`   composições: ${comps.length} (BDI=${bdi}%, leis=${leis}%)`);

// =====================================================================
// 4. Cria orçamento
// =====================================================================
console.log('\n4/9) POST /orc/orcamentos...');
const createResp = await postForm('/orc/orcamentos', {
  'orc_orcamento[codigo]': (lic.municipio ?? 'Picos').slice(0, 50),
  'orc_orcamento[descricao]': lic.titulo.slice(0, 250),
  'orc_orcamento[cliente_id]': '',
  'orc_orcamento[standard_category_name]': 'Infraestruturas Esportivas - Reforma',
  'orc_orcamento[custom_category_name]': '',
  'orc_orcamento[validity]': '',
  'orc_orcamento[insumos_zerados]': '1',
  'orc_orcamento[version_2023]': '1',
  'orc_orcamento[mask_itemization]': '1',
  'orc_orcamento[licitacao]': '1',
  'orc_orcamento[rounding_option]': '1',
}, 'createBudget');
const m = (createResp.location ?? '').match(/\/orc\/orcamentos\/([a-f0-9]{24})/);
if (!m) {
  console.error(`   ✗ Redirect inesperado: ${createResp.location}`);
  console.error(`   body: ${createResp.text.slice(0, 800)}`);
  process.exit(2);
}
const BUDGET_ID = m[1];
console.log(`   ✓ Budget criado: ${BUDGET_ID}`);
console.log(`   URL: ${BASE}/orc/orcamentos/${BUDGET_ID}`);

// =====================================================================
// 5. Update bases
// =====================================================================
console.log('\n5/9) POST /v2023/.../update_bases...');
const basesData = {
  atualizar_composicoes: '1',
  SINAPI_exibir_relatorio: '1',
  SINAPI_estado: (lic.uf ?? 'PI'),
  SINAPI_data: '03/2026',
};
if ((cab?.bases_utilizadas ?? []).includes('ORSE')) {
  basesData.ORSE_exibir_relatorio = '1';
  basesData.ORSE_estado = 'SE';
  basesData.ORSE_data = '02/2026';
}
if ((cab?.bases_utilizadas ?? []).includes('SICRO')) {
  basesData.SICRO_exibir_relatorio = '1';
  basesData.SICRO_estado = (lic.uf ?? 'PI');
  basesData.SICRO_data = '01/2026';
}
try {
  await postForm(`/v2023/bud/budgets/${BUDGET_ID}/update_bases`, basesData, 'updateBases');
  console.log(`   ✓ Bases configuradas`);
} catch (e) {
  console.warn(`   ⚠ updateBases: ${e.message.slice(0, 200)}`);
}

// =====================================================================
// 6. Update BDI
// =====================================================================
console.log('\n6/9) POST /v2023/.../update_bdi...');
try {
  await postForm(`/v2023/orc/orcamentos/update_bdi?id=${BUDGET_ID}`, {
    no_final: '1',
    bdi_manual: String(bdi),
    base_bdi: String(bdi),
  }, 'updateBdi');
  console.log(`   ✓ BDI ${bdi}% configurado`);
} catch (e) {
  console.warn(`   ⚠ updateBdi: ${e.message.slice(0, 200)}`);
}

// =====================================================================
// 7. Update leis sociais
// =====================================================================
console.log('\n7/9) POST /v2023/.../update_leis_sociais...');
try {
  await postForm(`/v2023/orc/orcamentos/update_leis_sociais?id=${BUDGET_ID}`, {
    desonerado: cab?.com_desoneracao ? '1' : '0',
    charge_manual: '0',
    charge_hourly: String(leis),
    charge_monthly: String((leis * 0.629).toFixed(2)),
    horista: String(leis),
    mensalista: String((leis * 0.629).toFixed(2)),
  }, 'updateLeisSociais');
  console.log(`   ✓ Leis sociais ${leis}% configuradas`);
} catch (e) {
  console.warn(`   ⚠ updateLeisSociais: ${e.message.slice(0, 200)}`);
}

// =====================================================================
// 8. Add items batch
// =====================================================================
console.log('\n8/9) POST /v2023/bud/budgets/{id}/items/ (BATCH)...');
function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
function fonteToBase(f) {
  if (!f) return 'OUTRA';
  const u = f.toUpperCase();
  if (['SINAPI', 'SBC', 'SICRO', 'ORSE', 'SEINFRA', 'FDE'].includes(u)) return u;
  if (u === 'PROPRIA') return 'MYBASE';
  return 'OUTRA';
}
const items = [];
for (const c of comps) {
  if (c.tipo_linha === 'grupo') {
    items.push({
      kind: 'phase',
      itemization: c.item_codigo,
      descr: (c.descricao ?? '').slice(0, 200),
      parent_descr: c.item_pai_codigo
        ? (comps.find((x) => x.item_codigo === c.item_pai_codigo)?.descricao ?? '').slice(0, 200)
        : '',
      qty: 1,
    });
  } else {
    const isPropria = c.fonte === 'PROPRIA';
    const code = isPropria ? (c.orcafascio_composition_id ?? c.codigo) : c.codigo;
    if (!code) continue;
    items.push({
      kind: 'composition',
      itemization: c.item_codigo,
      base: fonteToBase(c.fonte),
      base_id: uuidv4(),
      public_banco_id: isPropria ? (c.orcafascio_composition_id ?? '') : '',
      code: String(code),
      qty: Number(c.quantidade ?? 0),
    });
  }
}
console.log(`   ${items.length} items (${items.filter(x=>x.kind==='phase').length} etapas + ${items.filter(x=>x.kind==='composition').length} composições)`);

const itemsData = {};
items.forEach((it, idx) => {
  const p = `new_items[${idx}]`;
  itemsData[`${p}[kind]`] = it.kind;
  itemsData[`${p}[itemization]`] = it.itemization;
  itemsData[`${p}[qty]`] = String(it.qty ?? 1);
  if (it.kind === 'phase') {
    itemsData[`${p}[descr]`] = it.descr;
    itemsData[`${p}[parent_descr]`] = it.parent_descr;
  } else {
    itemsData[`${p}[base]`] = it.base;
    itemsData[`${p}[base_id]`] = it.base_id;
    itemsData[`${p}[public_banco_id]`] = it.public_banco_id;
    itemsData[`${p}[code]`] = it.code;
  }
});
try {
  const r = await postForm(`/v2023/bud/budgets/${BUDGET_ID}/items/`, itemsData, 'addItemsBatch');
  console.log(`   ✓ Batch enviado: ${r.status} ${r.text.slice(0, 100)}`);
} catch (e) {
  console.warn(`   ⚠ addItemsBatch: ${e.message.slice(0, 400)}`);
}

// =====================================================================
// 9. Transição licitação
// =====================================================================
console.log('\n9/9) Transição licitação → fase1_concluida...');
const currentStatus = (await sql(`SELECT status FROM licitacoes WHERE id='${LICITACAO_ID}'`))[0].status;
if (currentStatus === 'aguardando_revisao_humana') {
  await sql(`UPDATE licitacoes SET status='criando_composicoes_edital' WHERE id='${LICITACAO_ID}'`);
}
const s2 = (await sql(`SELECT status FROM licitacoes WHERE id='${LICITACAO_ID}'`))[0].status;
if (s2 === 'criando_composicoes_edital') {
  await sql(`UPDATE licitacoes SET status='criando_orcamento_base' WHERE id='${LICITACAO_ID}'`);
}
await sql(`UPDATE licitacoes SET status='fase1_concluida', fase1_concluida_em=now() WHERE id='${LICITACAO_ID}'`);
console.log(`   ✓ fase1_concluida`);

console.log('\n======================================================================');
console.log('✓ ORÇAMENTO CADASTRADO');
console.log('======================================================================');
console.log(`Budget ID:  ${BUDGET_ID}`);
console.log(`URL direta: ${BASE}/orc/orcamentos/${BUDGET_ID}`);
console.log(`Etapas:     ${items.filter(x=>x.kind==='phase').length}`);
console.log(`Itens:      ${items.filter(x=>x.kind==='composition').length}`);
console.log(`BDI:        ${bdi}%`);
console.log(`Leis soc.:  ${leis}% horista`);
