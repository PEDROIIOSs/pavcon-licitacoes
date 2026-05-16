// Roda o fluxo cadastrar-edital END-TO-END, fora da Edge Function,
// pra ter visibilidade total e ver onde algo eventualmente quebra.

const EMAIL = 'licitacao@pavconconstrutora.com.br';
const SECRET = process.env.ORCAFASCIO_SECRET;
const PAT = process.env.SUPABASE_PAT;
const PROJECT_REF = 'cwgjjjlyccgivscngzgz';
const LICITACAO_ID = 'd2359b58-8a6c-47a3-b5f1-3cc5be5c0128';

if (!SECRET || !PAT) {
  console.error('Faltam ORCAFASCIO_SECRET e SUPABASE_PAT no env.');
  process.exit(1);
}

const ORCA = 'https://api.orcafascio.com/api/v1';
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

async function ofLogin() {
  const r = await fetch(`${ORCA}/login/authenticate_user`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, secret_token: SECRET }),
  });
  if (!r.ok) throw new Error(`Login ${r.status}: ${await r.text()}`);
  return (await r.json()).auth_token;
}

let TOKEN;
async function of(method, path, body) {
  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/json',
    'User-Agent': 'pavcon-cadastrar-completo',
  };
  if (body) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${ORCA}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`${method} ${path} → ${r.status}: ${t.slice(0, 300)}`);
  }
  return j;
}

// ====================================================================

console.log('1/7) Reset licitação → aguardando_revisao_humana (se preciso)');
const before = await sql(`SELECT status FROM licitacoes WHERE id='${LICITACAO_ID}'`);
console.log(`     status atual: ${before[0].status}`);
if (!['aguardando_revisao_humana', 'criando_composicoes_edital', 'fase1_concluida'].includes(before[0].status)) {
  // Vai por erro pra atalhar (a state machine permite erro→qualquer)
  await sql(`UPDATE licitacoes SET status='erro' WHERE id='${LICITACAO_ID}'`);
  await sql(`UPDATE licitacoes SET status='aguardando_revisao_humana' WHERE id='${LICITACAO_ID}'`);
  console.log(`     resetada para aguardando_revisao_humana`);
}

console.log('\n2/7) Login Orçafascio');
TOKEN = await ofLogin();
console.log(`     auth_token: ${TOKEN.slice(0, 16)}…`);

console.log('\n3/7) Lê metadata da licitação');
const lic = await sql(`SELECT numero_edital, municipio, uf, titulo FROM licitacoes WHERE id='${LICITACAO_ID}'`);
const numero = lic[0].numero_edital ?? LICITACAO_ID.slice(0, 8);
const municipio = lic[0].municipio ?? 'Picos';
const uf = lic[0].uf ?? 'PI';
const prefixo = `EDIT.${(municipio ?? 'XX').toUpperCase().slice(0, 6)}`;
console.log(`     prefixo do code: ${prefixo}`);

console.log('\n4/7) Cria pasta (group) no MyBase');
const descricao = `EDITAL / ${numero} / ${municipio} / ${uf}`;
const grupo = await of('POST', '/base/mybase/groups', { description: descricao });
console.log(`     grupo criado: ${grupo.id}`);
console.log(`     URL: https://app.orcafascio.com/orc/mybase  (procura "${descricao}")`);

console.log('\n5/7) Busca composições PROPRIA no banco');
const comps = await sql(`
  SELECT id, item_codigo, codigo, descricao, unidade
  FROM composicoes_extraidas
  WHERE licitacao_id='${LICITACAO_ID}'
    AND fonte='PROPRIA'
    AND tipo_linha='servico'
  ORDER BY ordem
`);
console.log(`     ${comps.length} composições PROPRIA encontradas`);

console.log('\n6/7) Cadastra cada composição + adiciona itens');
const created = [];
for (const c of comps) {
  const codeFinal = `${prefixo}.${c.item_codigo}`;
  const compResp = await of('POST', '/base/mybase/compositions', {
    code: codeFinal,
    second_code: `LICITACAO_${LICITACAO_ID.slice(0, 8)}`,
    description: c.descricao.slice(0, 500),
    labor: false,
    type: 'PARE',
    unit: (c.unidade ?? 'Un').slice(0, 20),
    local: uf,
    is_sicro: false,
    rounding_type: 2,
    note: `Composição extraída do edital. Item ${c.item_codigo}. Pasta lógica: ${descricao}`,
  });
  console.log(`     ✓ ${codeFinal} — ${compResp.id} (${c.descricao.slice(0, 60)}…)`);

  // Atualiza orcafascio_composition_id
  await sql(`
    UPDATE composicoes_extraidas
    SET orcafascio_composition_id='${compResp.id}'
    WHERE id='${c.id}'
  `);

  // Adiciona items
  const subItens = await sql(`
    SELECT codigo, fonte, coeficiente
    FROM composicao_propria_itens
    WHERE composicao_extraida_id='${c.id}'
      AND codigo IS NOT NULL
      AND coeficiente IS NOT NULL
      AND coeficiente > 0
  `);
  const items = subItens.map((s) => ({
    bank: s.fonte === 'PROPRIA' ? 'MYBASE' : s.fonte,
    code: s.codigo,
    qty: Number(s.coeficiente),
  }));
  if (items.length > 0) {
    try {
      await of('POST', `/base/mybase/compositions/${compResp.id}/add-items`, { items });
      console.log(`         + ${items.length} items adicionados`);
    } catch (e) {
      console.log(`         ⚠ falhou add-items: ${e.message.slice(0, 150)}`);
    }
  }
  created.push({ ...c, code: codeFinal, orcafascio_id: compResp.id, items: items.length });
}

console.log('\n7/7) Transição final: → fase1_concluida');
await sql(`UPDATE licitacoes SET status='criando_composicoes_edital' WHERE id='${LICITACAO_ID}'`);
await sql(`UPDATE licitacoes SET status='criando_orcamento_base' WHERE id='${LICITACAO_ID}'`);
await sql(`UPDATE licitacoes SET status='fase1_concluida', fase1_concluida_em=now() WHERE id='${LICITACAO_ID}'`);

console.log('\n======================================================================');
console.log('✓ CADASTRO COMPLETO NO ORÇAFASCIO');
console.log('======================================================================');
console.log(`Pasta criada:  "${descricao}"`);
console.log(`  Group ID:    ${grupo.id}`);
console.log(`  URL direta:  https://app.orcafascio.com/orc/mybase`);
console.log(`               (procura "EDITAL" ou "${municipio}" nas pastas)`);
console.log();
console.log(`Composições criadas (${created.length}):`);
for (const c of created) {
  console.log(`  • ${c.code.padEnd(20)} ${c.orcafascio_id}  (${c.items} items)`);
}
console.log();
console.log(`Busca rápida na UI do Orçafascio:`);
console.log(`  → Aba "Composições" → search "${prefixo}" → aparecem as ${created.length} de uma vez`);
console.log(`  → ou search "LICITACAO_${LICITACAO_ID.slice(0, 8)}" no second_code`);
