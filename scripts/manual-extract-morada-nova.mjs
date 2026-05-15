// Inserção manual da extração do PDF "ORÇA REFORMA QUADRA MORADA NOVA ONERADO.pdf"
// (extraído manualmente por Claude no chat porque a key da Anthropic ainda não foi cadastrada).
//
// Uso:
//   SUPABASE_PROJECT_REF=cwgjjjlyccgivscngzgz \
//   SUPABASE_PAT=sbp_... \
//   node scripts/manual-extract-morada-nova.mjs

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF;
const PAT = process.env.SUPABASE_PAT;
const LICITACAO_ID = process.env.LICITACAO_ID;
const ARQUIVO_ID = process.env.ARQUIVO_ID;
const USER_ID = process.env.USER_ID;

if (!PROJECT_REF || !PAT || !LICITACAO_ID || !ARQUIVO_ID || !USER_ID) {
  console.error('Falta env: SUPABASE_PROJECT_REF, SUPABASE_PAT, LICITACAO_ID, ARQUIVO_ID, USER_ID');
  process.exit(1);
}

// JSON estruturado conforme schema do prompt pavcon-extracao-edital-v1
const JSON_EXTRAIDO = {
  cabecalho: {
    orgao: 'SECRETARIA MUNICIPAL DE ESPORTES E LAZER DE PICOS/PI',
    objeto: 'REFORMA DE QUADRA POLIESPORTIVA - MORADA NOVA',
    municipio: 'Picos',
    uf: 'PI',
    numero_edital: null,
    data_base_descricao: 'SINAPI 03/2026 PI, SICRO3 01/2026 PI, ORSE 02/2026 SE',
    bases_utilizadas: ['SINAPI', 'SICRO', 'ORSE'],
    com_desoneracao: false,
    leis_sociais_percentual: 113.78,
    bdi_percentual: 22.0,
  },
  itens: [
    // Grupo 1 — ADMINISTRAÇÃO LOCAL DA OBRA
    { item_codigo: '1', nivel: 1, pai: null, tipo: 'grupo', codigo: null, fonte: null, descricao: 'ADMINISTRAÇÃO LOCAL DA OBRA', unidade: null, quantidade: null, preco_unitario_sem_bdi: null, preco_unitario_com_bdi: null, preco_total: 5979.16 },
    { item_codigo: '1.1', nivel: 2, pai: '1', tipo: 'servico', codigo: 'COMP_ADM', fonte: 'PROPRIA', descricao: 'ADMINISTRAÇÃO LOCAL DA OBRA', unidade: 'MÊS', quantidade: 4, preco_unitario_sem_bdi: 1225.24, preco_unitario_com_bdi: 1494.79, preco_total: 5979.16,
      composicao_propria: { itens: [
        { classe: 'COMPOSICAO', codigo: '90777',  fonte: 'SINAPI', descricao: 'ENGENHEIRO CIVIL DE OBRA JUNIOR COM ENCARGOS COMPLEMENTARES', unidade: 'H', coeficiente: 4,  preco_unitario: 141.05 },
        { classe: 'COMPOSICAO', codigo: '100309', fonte: 'SINAPI', descricao: 'TÉCNICO EM SEGURANÇA DO TRABALHO COM ENCARGOS COMPLEMENTARES',     unidade: 'H', coeficiente: 4,  preco_unitario: 32.58 },
        { classe: 'COMPOSICAO', codigo: '88284',  fonte: 'SINAPI', descricao: 'MOTORISTA DE VEÍCULO LEVE COM ENCARGOS COMPLEMENTARES',           unidade: 'H', coeficiente: 8,  preco_unitario: 25.22 },
        { classe: 'COMPOSICAO', codigo: '90776',  fonte: 'SINAPI', descricao: 'ENCARREGADO GERAL COM ENCARGOS COMPLEMENTARES',                   unidade: 'H', coeficiente: 8,  preco_unitario: 41.12 },
      ]} },

    // Grupo 2 — SERVIÇOS PRELIMINARES
    { item_codigo: '2', nivel: 1, pai: null, tipo: 'grupo', codigo: null, fonte: null, descricao: 'SERVIÇOS PRELIMINARES', unidade: null, quantidade: null, preco_unitario_sem_bdi: null, preco_unitario_com_bdi: null, preco_total: 8719.18 },
    { item_codigo: '2.1', nivel: 2, pai: '2', tipo: 'servico', codigo: '103689', fonte: 'SINAPI', descricao: 'FORNECIMENTO E INSTALAÇÃO DE PLACA DE OBRA COM CHAPA GALVANIZADA E ESTRUTURA DE MADEIRA. AF_03/2022_PS', unidade: 'm²', quantidade: 6,    preco_unitario_sem_bdi: 499.20,  preco_unitario_com_bdi: 609.02,  preco_total: 3654.12 },
    { item_codigo: '2.2', nivel: 2, pai: '2', tipo: 'servico', codigo: '93358',  fonte: 'SINAPI', descricao: 'ESCAVAÇÃO MANUAL DE VALA. AF_09/2024',                                                                       unidade: 'm³', quantidade: 1.86, preco_unitario_sem_bdi: 93.59,   preco_unitario_com_bdi: 114.17,  preco_total: 212.35 },
    { item_codigo: '2.3', nivel: 2, pai: '2', tipo: 'servico', codigo: 'COMP_ESC', fonte: 'PROPRIA', descricao: 'ESCARIFICAÇÃO DE PISO', unidade: 'm³', quantidade: 18.12, preco_unitario_sem_bdi: 219.52, preco_unitario_com_bdi: 267.81, preco_total: 4852.71,
      composicao_propria: { itens: [
        { classe: 'COMPOSICAO', codigo: '88309', fonte: 'SINAPI', descricao: 'PEDREIRO COM ENCARGOS COMPLEMENTARES', unidade: 'H', coeficiente: 1.2462, preco_unitario: 29.47 },
        { classe: 'COMPOSICAO', codigo: '88316', fonte: 'SINAPI', descricao: 'SERVENTE COM ENCARGOS COMPLEMENTARES', unidade: 'H', coeficiente: 7.7265, preco_unitario: 23.66 },
      ]} },

    // Grupo 3 — ALAMBRADO
    { item_codigo: '3', nivel: 1, pai: null, tipo: 'grupo', codigo: null, fonte: null, descricao: 'ALAMBRADO', unidade: null, quantidade: null, preco_unitario_sem_bdi: null, preco_unitario_com_bdi: null, preco_total: 81995.45 },
    { item_codigo: '3.1', nivel: 2, pai: '3', tipo: 'servico', codigo: 'COMP_ALAMB', fonte: 'PROPRIA', descricao: 'ALAMBRADO PARA QUADRA POLIESPORTIVA, ESTRUTURADO POR TUBOS DE ACO GALVANIZADO, (MONTANTES COM DIAMETRO 2", TRAVESSAS E ESCORAS COM DIÂMETRO 2"), COM TELA DE ARAME GALVANIZADO, FIO 12 BWG E MALHA QUADRADA 5X5CM (EXCETO MURETA).', unidade: 'm²', quantidade: 253.26, preco_unitario_sem_bdi: 204.56, preco_unitario_com_bdi: 249.56, preco_total: 63203.56,
      composicao_propria: { itens: [
        { classe: 'COMPOSICAO', codigo: '88316', fonte: 'SINAPI', descricao: 'SERVENTE COM ENCARGOS COMPLEMENTARES',                                                                                                                              unidade: 'H',  coeficiente: 0.9774, preco_unitario: 23.66 },
        { classe: 'COMPOSICAO', codigo: '94962', fonte: 'SINAPI', descricao: 'CONCRETO MAGRO PARA LASTRO, TRAÇO 1:4,5:4,5 (EM MASSA SECA DE CIMENTO/ AREIA MÉDIA/ BRITA 1) - PREPARO MECÂNICO COM BETONEIRA 400 L. AF_05/2021',                  unidade: 'm³', coeficiente: 0.0045, preco_unitario: 553.17 },
        { classe: 'COMPOSICAO', codigo: '88315', fonte: 'SINAPI', descricao: 'SERRALHEIRO COM ENCARGOS COMPLEMENTARES',                                                                                                                            unidade: 'H',  coeficiente: 0.9774, preco_unitario: 29.26 },
        { classe: 'INSUMO',     codigo: '7696',  fonte: 'SINAPI', descricao: 'TUBO ACO GALVANIZADO COM COSTURA, CLASSE MEDIA, DN 2", E = *3,65* MM, PESO *5,10* KG/M (NBR 5580)',                                                                  unidade: 'M',  coeficiente: 1.4806, preco_unitario: 74.02 },
        { classe: 'INSUMO',     codigo: '43130', fonte: 'SINAPI', descricao: 'ARAME GALVANIZADO 12 BWG, D = 2,76 MM (0,048 KG/M) OU 14 BWG, D = 2,11 MM (0,026 KG/M)',                                                                              unidade: 'KG', coeficiente: 0.0797, preco_unitario: 21.27 },
        { classe: 'INSUMO',     codigo: '7158',  fonte: 'SINAPI', descricao: 'TELA DE ARAME GALVANIZADA QUADRANGULAR / LOSANGULAR, FIO 2,77 MM (12 BWG), MALHA 5 X 5 CM, H = 2 M',                                                                  unidade: 'm²', coeficiente: 1.0203, preco_unitario: 38.25 },
        { classe: 'INSUMO',     codigo: '11002', fonte: 'SINAPI', descricao: 'ELETRODO REVESTIDO AWS - E6013, DIAMETRO IGUAL A 2,50 MM',                                                                                                            unidade: 'KG', coeficiente: 0.0025, preco_unitario: 31.61 },
      ]} },
    { item_codigo: '3.2', nivel: 2, pai: '3', tipo: 'servico', codigo: '2311', fonte: 'ORSE', descricao: 'Pintura de acabamento com lixamento, aplicação de 01 demão de tinta à base dezarcão e 02 demãos de tinta esmalte', unidade: 'm²', quantidade: 506.52, preco_unitario_sem_bdi: 30.41, preco_unitario_com_bdi: 37.10, preco_total: 18791.89 },

    // Grupo 4 — ESTRUTURAS
    { item_codigo: '4', nivel: 1, pai: null, tipo: 'grupo', codigo: null, fonte: null, descricao: 'ESTRUTURAS', unidade: null, quantidade: null, preco_unitario_sem_bdi: null, preco_unitario_com_bdi: null, preco_total: 5067.66 },
    { item_codigo: '4.1', nivel: 2, pai: '4', tipo: 'servico', codigo: '104919', fonte: 'SINAPI', descricao: 'ARMAÇÃO DE SAPATA ISOLADA, VIGA BALDRAME E SAPATA CORRIDA UTILIZANDO AÇO CA-50 DE 10 MM - MONTAGEM. AF_01/2024', unidade: 'KG',  quantidade: 74,    preco_unitario_sem_bdi: 12.50,  preco_unitario_com_bdi: 15.25,  preco_total: 1128.50 },
    { item_codigo: '4.2', nivel: 2, pai: '4', tipo: 'servico', codigo: '104916', fonte: 'SINAPI', descricao: 'ARMAÇÃO DE SAPATA ISOLADA, VIGA BALDRAME E SAPATA CORRIDA UTILIZANDO AÇO CA-60 DE 5 MM - MONTAGEM. AF_01/2024',  unidade: 'KG',  quantidade: 29.57, preco_unitario_sem_bdi: 16.77,  preco_unitario_com_bdi: 20.45,  preco_total: 604.70 },
    { item_codigo: '4.3', nivel: 2, pai: '4', tipo: 'servico', codigo: '94971',  fonte: 'SINAPI', descricao: 'CONCRETO FCK = 25MPA, TRAÇO 1:2,3:2,7 (EM MASSA SECA DE CIMENTO/ AREIA MÉDIA/ BRITA 1) - PREPARO MECÂNICO COM BETONEIRA 600 L. AF_05/2021', unidade: 'm³', quantidade: 1.86, preco_unitario_sem_bdi: 702.89, preco_unitario_com_bdi: 857.52, preco_total: 1594.98 },
    { item_codigo: '4.4', nivel: 2, pai: '4', tipo: 'servico', codigo: '103670', fonte: 'SINAPI', descricao: 'LANÇAMENTO COM USO DE BALDES, ADENSAMENTO E ACABAMENTO DE CONCRETO EM ESTRUTURAS. AF_02/2022',                  unidade: 'm³', quantidade: 1.86, preco_unitario_sem_bdi: 319.87, preco_unitario_com_bdi: 390.24, preco_total: 725.84 },
    { item_codigo: '4.5', nivel: 2, pai: '4', tipo: 'servico', codigo: 'COMP_GRAUTE', fonte: 'PROPRIA', descricao: 'LANÇAMENTO DE GRAUTE EM RECUPERAÇÃO DE ESTRUTURAS.', unidade: 'm³', quantidade: 0.508, preco_unitario_sem_bdi: 1635.55, preco_unitario_com_bdi: 1995.37, preco_total: 1013.64,
      composicao_propria: { itens: [
        { classe: 'COMPOSICAO', codigo: '88316', fonte: 'SINAPI', descricao: 'SERVENTE COM ENCARGOS COMPLEMENTARES',                                                                                              unidade: 'H',  coeficiente: 5.5315, preco_unitario: 23.66 },
        { classe: 'COMPOSICAO', codigo: '90281', fonte: 'SINAPI', descricao: 'GRAUTE FGK=30 MPA; TRAÇO 1:0,02:0,9:1,2 (EM MASSA SECA DE CIMENTO/ CAL/ AREIA GROSSA/ BRITA 0) - PREPARO MECÂNICO COM BETONEIRA 400 L. AF_09/2021', unidade: 'm³', coeficiente: 1.203,  preco_unitario: 1047.52 },
        { classe: 'COMPOSICAO', codigo: '88309', fonte: 'SINAPI', descricao: 'PEDREIRO COM ENCARGOS COMPLEMENTARES',                                                                                              unidade: 'H',  coeficiente: 8.2973, preco_unitario: 29.47 },
      ]} },

    // Grupo 5 — RECUPERAÇÃO DE PISO
    { item_codigo: '5', nivel: 1, pai: null, tipo: 'grupo', codigo: null, fonte: null, descricao: 'RECUPERAÇÃO DE PISO', unidade: null, quantidade: null, preco_unitario_sem_bdi: null, preco_unitario_com_bdi: null, preco_total: 24448.94 },
    { item_codigo: '5.1', nivel: 2, pai: '5', tipo: 'servico', codigo: '10011', fonte: 'ORSE',   descricao: 'Fornecimento e instalação de tela aço soldada nervurada CA-60, malha 15x15cm,ferro 3.4mm, painel 2x3m, (1,00kg/m²), Malha Pop Média Gerdau ou similar', unidade: 'm²', quantidade: 362.4, preco_unitario_sem_bdi: 19.22, preco_unitario_com_bdi: 23.44, preco_total: 8494.65 },
    { item_codigo: '5.2', nivel: 2, pai: '5', tipo: 'servico', codigo: '97096', fonte: 'SINAPI', descricao: 'CONCRETAGEM DE RADIER, PISO DE CONCRETO OU LAJE SOBRE SOLO, FCK 30 MPA - LANÇAMENTO, ADENSAMENTO E ACABAMENTO. AF_09/2021', unidade: 'm³', quantidade: 18.12, preco_unitario_sem_bdi: 721.71, preco_unitario_com_bdi: 880.48, preco_total: 15954.29 },

    // Grupo 6 — PINTURA DE PISO
    { item_codigo: '6', nivel: 1, pai: null, tipo: 'grupo', codigo: null, fonte: null, descricao: 'PINTURA DE PISO', unidade: null, quantidade: null, preco_unitario_sem_bdi: null, preco_unitario_com_bdi: null, preco_total: 33408.02 },
    { item_codigo: '6.1', nivel: 2, pai: '6', tipo: 'servico', codigo: '102494', fonte: 'SINAPI', descricao: 'PINTURA DE PISO COM TINTA EPÓXI, APLICAÇÃO MANUAL, 2 DEMÃOS, INCLUSO PRIMER EPÓXI. AF_05/2021',     unidade: 'm²', quantidade: 362.4, preco_unitario_sem_bdi: 68.66, preco_unitario_com_bdi: 83.76, preco_total: 30354.62 },
    { item_codigo: '6.2', nivel: 2, pai: '6', tipo: 'servico', codigo: '102506', fonte: 'SINAPI', descricao: 'PINTURA DE DEMARCAÇÃO DE QUADRA POLIESPORTIVA COM TINTA EPÓXI, E = 5 CM, APLICAÇÃO MANUAL. AF_05/2021', unidade: 'M',  quantidade: 210,  preco_unitario_sem_bdi: 11.92, preco_unitario_com_bdi: 14.54, preco_total: 3053.40 },

    // Grupo 7 — EXTRAS
    { item_codigo: '7', nivel: 1, pai: null, tipo: 'grupo', codigo: null, fonte: null, descricao: 'EXTRAS', unidade: null, quantidade: null, preco_unitario_sem_bdi: null, preco_unitario_com_bdi: null, preco_total: 5169.55 },
    { item_codigo: '7.1', nivel: 2, pai: '7', tipo: 'servico', codigo: '10069', fonte: 'ORSE', descricao: 'Traves oficial para futebol de salão 3x2m em aço galv.3", com requadro e redes de polietileno fio 4mm (conjunto p/futsal)', unidade: 'par', quantidade: 1, preco_unitario_sem_bdi: 4237.34, preco_unitario_com_bdi: 5169.55, preco_total: 5169.55 },
  ],
};

const API_URL = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

async function runSql(query, params = []) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, params }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SQL HTTP ${res.status}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

// Limpa extrações órfãs e composições antigas dessa licitação
console.log('Limpando extrações antigas...');
await runSql(`DELETE FROM extracoes_ocr WHERE licitacao_id = '${LICITACAO_ID}'`);
console.log('  OK');

// Cria extracao_ocr com status=sucesso e o JSON
console.log('Criando extracao_ocr...');
const extrEscaped = JSON.stringify(JSON_EXTRAIDO).replace(/'/g, "''");
const extrResult = await runSql(`
  INSERT INTO extracoes_ocr (licitacao_id, arquivo_id, llm_provider, llm_model, prompt_versao, status, json_extraido, tokens_input, tokens_output, custo_usd, duracao_ms, concluido_em)
  VALUES (
    '${LICITACAO_ID}',
    '${ARQUIVO_ID}',
    'anthropic',
    'claude-opus-4-7 (manual via Claude Code)',
    'pavcon-extracao-edital-v1',
    'sucesso',
    '${extrEscaped}'::jsonb,
    NULL, NULL, 0, 0,
    now()
  )
  RETURNING id
`);
const extracaoId = extrResult[0].id;
console.log(`  extracao_id: ${extracaoId}`);

// Insere composicoes_extraidas
console.log('Inserindo composicoes_extraidas...');
const compValues = [];
JSON_EXTRAIDO.itens.forEach((item, idx) => {
  const v = [
    `'${LICITACAO_ID}'`,
    `'${extracaoId}'`,
    `'${item.item_codigo.replace(/'/g, "''")}'`,
    item.nivel,
    item.pai ? `'${item.pai}'` : 'NULL',
    `'${item.tipo}'`,
    item.codigo ? `'${item.codigo.replace(/'/g, "''")}'` : 'NULL',
    item.fonte ? `'${item.fonte}'` : 'NULL',
    `'${item.descricao.replace(/'/g, "''")}'`,
    item.unidade ? `'${item.unidade}'` : 'NULL',
    item.quantidade == null ? 'NULL' : item.quantidade,
    item.preco_unitario_sem_bdi == null ? 'NULL' : item.preco_unitario_sem_bdi,
    item.preco_unitario_com_bdi == null ? 'NULL' : item.preco_unitario_com_bdi,
    item.preco_total == null ? 'NULL' : item.preco_total,
    idx,
    `'{}'::jsonb`,
  ];
  compValues.push(`(${v.join(',')})`);
});
const insertSql = `
  INSERT INTO composicoes_extraidas
    (licitacao_id, extracao_id, item_codigo, item_nivel, item_pai_codigo, tipo_linha, codigo, fonte, descricao, unidade, quantidade, preco_unitario_sem_bdi, preco_unitario_com_bdi, preco_total, ordem, metadata)
  VALUES ${compValues.join(',')}
  RETURNING id, item_codigo
`;
const compResult = await runSql(insertSql);
console.log(`  ${compResult.length} composições inseridas`);

// Map item_codigo → id
const idByCodigo = new Map(compResult.map((c) => [c.item_codigo, c.id]));

// Insere composicao_propria_itens
console.log('Inserindo composicao_propria_itens...');
const subValues = [];
JSON_EXTRAIDO.itens.forEach((item) => {
  if (!item.composicao_propria?.itens) return;
  const compId = idByCodigo.get(item.item_codigo);
  if (!compId) return;
  item.composicao_propria.itens.forEach((sub, i) => {
    const v = [
      `'${compId}'`,
      `'${sub.classe}'`,
      sub.codigo ? `'${sub.codigo}'` : 'NULL',
      `'${sub.fonte}'`,
      `'${sub.descricao.replace(/'/g, "''")}'`,
      sub.unidade ? `'${sub.unidade}'` : 'NULL',
      sub.coeficiente,
      sub.preco_unitario == null ? 'NULL' : sub.preco_unitario,
      sub.preco_unitario == null ? 'NULL' : (sub.coeficiente * sub.preco_unitario).toFixed(4),
      i,
    ];
    subValues.push(`(${v.join(',')})`);
  });
});
if (subValues.length > 0) {
  await runSql(`
    INSERT INTO composicao_propria_itens
      (composicao_extraida_id, classe, codigo, fonte, descricao, unidade, coeficiente, preco_unitario, preco_total, ordem)
    VALUES ${subValues.join(',')}
  `);
}
console.log(`  ${subValues.length} sub-itens inseridos`);

// Transiciona licitação rascunho → aguardando_extracao → extraindo → extracao_concluida → aguardando_revisao_humana
console.log('Transicionando status...');
for (const s of ['aguardando_extracao', 'extraindo', 'extracao_concluida', 'aguardando_revisao_humana']) {
  await runSql(`UPDATE licitacoes SET status = '${s}' WHERE id = '${LICITACAO_ID}'`);
}
console.log('  → aguardando_revisao_humana');

console.log('\n✓ Inserção manual concluída!');
console.log(`  Licitação: ${LICITACAO_ID}`);
console.log(`  Extração:  ${extracaoId}`);
console.log(`  Itens:     ${JSON_EXTRAIDO.itens.length} (7 grupos + 16 serviços)`);
console.log(`  Sub-itens: ${subValues.length}`);
console.log('\nAgora abre o app em http://localhost:3000/licitacoes/' + LICITACAO_ID);
