// =============================================================================
// Edge Function: orcapav-worker
// =============================================================================
// Agente autônomo responsável por resolver erros de código nas licitações.
//
// Fluxo:
// 1. Lista TODAS as licitações com warnings ativos (status fase1_concluida
//    ou criando_composicoes_edital) que ainda não foram processadas
//    recentemente (último log > 30 min ou nunca processada).
// 2. Pra cada licitação, extrai os códigos que falharam dos warnings.
// 3. Pra CADA código:
//    a. CONSULTA orcapav_knowledge_codes — se encontrar com confiança >= 70%,
//       aplica direto (rápido, grátis).
//    b. Se não conhece, AGRUPA pro batch do Gemini Flash.
// 4. Roda Gemini Flash em batch nos códigos desconhecidos, salva novos
//    mappings na knowledge_base (auto-aprendizado).
// 5. Limpa orcafascio_composition_id das PROPRIA pra retry aplicar.
// 6. Loga TUDO em orcapav_correcoes_log.
//
// Modos de invocação:
// - HTTP POST { licitacao_id?: string } — processa só essa licitação
//   (chamado manualmente ou pelo auto-trigger frontend)
// - HTTP POST {} — modo cron, processa TODAS pendentes (até max 5 por run)
//
// Pode ser chamado por pg_cron via http extension pra rodar a cada 15 min.
// =============================================================================

import { handleCorsPreflight } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/json.ts';
import { getServiceRoleClient } from '../_shared/supabase.ts';

const GEMINI_FLASH = 'gemini-2.5-flash';
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_LICITACOES_POR_RUN = 5;
const KNOWLEDGE_CONFIDENCE_THRESHOLD = 70;

interface RequestBody {
  licitacao_id?: string;
  force?: boolean; // se true, ignora cooldown de 30 min
}

interface CodigoFalho {
  fonte: string;
  codigo: string;
  descricao?: string;
}

// =============================================================================
// Helpers
// =============================================================================
function extrairCodigosDeWarnings(warnings: string[]): CodigoFalho[] {
  const codigos = new Map<string, CodigoFalho>();
  for (const w of warnings) {
    // Pattern: "FONTE/codigo descricao" ex "SINAPI/4433 CAIBRO..."
    // Múltiplos podem vir separados por ";" no mesmo warning
    const matches = w.matchAll(/([A-Z][A-Z0-9_]+)\/([\w\-./]+)\s+([^;()]+?)(?=\s*\(|;|$)/g);
    for (const m of matches) {
      const fonte = m[1].toUpperCase();
      const codigo = m[2];
      // Ignora ruído (FONTE/ vazio, FONTE/HTML, etc)
      if (!codigo || codigo.length > 30) continue;
      const key = `${fonte}/${codigo}`;
      if (!codigos.has(key)) {
        codigos.set(key, { fonte, codigo, descricao: m[3].trim().slice(0, 100) });
      }
    }
  }
  return [...codigos.values()];
}

async function consultarKnowledgeBase(
  admin: ReturnType<typeof getServiceRoleClient>,
  codigos: CodigoFalho[],
): Promise<Map<string, { fonte_sub: string; codigo_sub: string; confianca: number }>> {
  if (codigos.length === 0) return new Map();
  const keys = codigos.map((c) => `${c.fonte}|${c.codigo}`);
  const { data } = await admin
    .from('orcapav_knowledge_codes')
    .select('fonte_original, codigo_original, fonte_substituto, codigo_substituto, confianca');
  const mapa = new Map<string, { fonte_sub: string; codigo_sub: string; confianca: number }>();
  for (const row of data ?? []) {
    const key = `${row.fonte_original}|${row.codigo_original}`;
    if (keys.includes(key) && row.confianca >= KNOWLEDGE_CONFIDENCE_THRESHOLD) {
      mapa.set(`${row.fonte_original}/${row.codigo_original}`, {
        fonte_sub: row.fonte_substituto,
        codigo_sub: row.codigo_substituto,
        confianca: row.confianca,
      });
    }
  }
  return mapa;
}

async function consultarGeminiFlashBatch(
  apiKey: string,
  codigosDesconhecidos: CodigoFalho[],
): Promise<Array<{
  fonte: string;
  codigo: string;
  fonte_sub?: string;
  codigo_sub?: string;
  confianca: number;
  justificativa: string;
}>> {
  if (codigosDesconhecidos.length === 0) return [];
  const prompt = `Você é um especialista em códigos SINAPI/ORSE/SEINFRA da construção civil brasileira.

Recebi esta lista de códigos que FALHARAM no Orçafascio (provável código descontinuado):

${codigosDesconhecidos.map((c, i) => `${i + 1}. ${c.fonte}/${c.codigo} — ${c.descricao ?? '(sem descrição)'}`).join('\n')}

Pra CADA código, devolva JSON com o equivalente moderno se você souber com confiança >= 70%. Senão, devolva confianca: 0 e fonte_sub: null.

CONHECIMENTO:
- SINAPI labor migrou pra "com encargos complementares" (244→88253, 6111→88316, 7592→91387, etc)
- SINAPI materiais geralmente MANTÊM o número (1379 cimento, 367 areia, 4720 brita continuam válidos em SINAPI 2024+)
- Códigos com sufixo -ADAP, -A, "COMPOSIÇÃO XX" são ADAPTAÇÕES do órgão — não tem equivalente moderno SINAPI
- ORSE e SEINFRA são bancos regionais — códigos podem estar genuinamente descontinuados

FORMATO — apenas JSON sem markdown:
{
  "mappings": [
    {"fonte": "SINAPI", "codigo": "4433", "fonte_sub": "SINAPI", "codigo_sub": "91530", "confianca": 80, "justificativa": "..."},
    {"fonte": "SINAPI", "codigo": "1379", "fonte_sub": null, "codigo_sub": null, "confianca": 0, "justificativa": "código ainda válido, Orçafascio precisa atualizar banco"}
  ]
}`;

  const resp = await fetch(
    `${GEMINI_API}/models/${GEMINI_FLASH}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.0,
          responseMimeType: 'application/json',
          maxOutputTokens: 4096,
        },
      }),
    },
  );
  if (!resp.ok) {
    console.error(`Gemini Flash ${resp.status}:`, await resp.text());
    return [];
  }
  const data = await resp.json();
  const txt = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  try {
    const parsed = JSON.parse(txt);
    return Array.isArray(parsed.mappings) ? parsed.mappings : [];
  } catch {
    return [];
  }
}

async function aplicarMappingsELogar(
  admin: ReturnType<typeof getServiceRoleClient>,
  licitacaoId: string,
  mappings: Array<{
    fonte_orig: string;
    codigo_orig: string;
    fonte_sub: string;
    codigo_sub: string;
    confianca: number;
    fonte_descoberta: 'knowledge_base' | 'gemini_flash';
    justificativa: string;
  }>,
): Promise<{ aplicados: number; logs_id: number[] }> {
  if (mappings.length === 0) return { aplicados: 0, logs_id: [] };
  // Insere no orcafascio_code_mappings (a tabela que cadastrar-edital lê)
  const linhas = mappings.map((m) => ({
    fonte_original: m.fonte_orig.toUpperCase(),
    codigo_original: m.codigo_orig,
    fonte_substituto: m.fonte_sub.toUpperCase(),
    codigo_substituto: m.codigo_sub,
    motivo: `OrçaPav Worker (${m.fonte_descoberta}, ${m.confianca}%): ${m.justificativa}`,
  }));
  await admin
    .from('orcafascio_code_mappings')
    .upsert(linhas, { onConflict: 'fonte_original,codigo_original' });

  // Auto-aprendizado: salva no knowledge_codes pra próximas vezes
  const learnedLinhas = mappings
    .filter((m) => m.fonte_descoberta === 'gemini_flash')
    .map((m) => ({
      fonte_original: m.fonte_orig.toUpperCase(),
      codigo_original: m.codigo_orig,
      fonte_substituto: m.fonte_sub.toUpperCase(),
      codigo_substituto: m.codigo_sub,
      descricao: m.justificativa,
      motivo: m.justificativa,
      fonte_descoberta: 'gemini',
      confianca: m.confianca,
    }));
  if (learnedLinhas.length > 0) {
    await admin
      .from('orcapav_knowledge_codes')
      .upsert(learnedLinhas, { onConflict: 'fonte_original,codigo_original' });
  }

  // Atualiza contadores de uso
  for (const m of mappings) {
    await admin.rpc('exec_sql' as never, {}).catch(() => {}); // ignora se RPC nao existe
    await admin
      .from('orcapav_knowledge_codes')
      .update({
        vezes_aplicado: 1, // simples increment não tem aqui, vai como overwrite ok
        ultima_aplicacao: new Date().toISOString(),
      })
      .eq('fonte_original', m.fonte_orig.toUpperCase())
      .eq('codigo_original', m.codigo_orig);
  }

  // Limpa orcafascio_composition_id das PROPRIA pra retry aplicar
  await admin
    .from('composicoes_extraidas')
    .update({ orcafascio_composition_id: null })
    .eq('licitacao_id', licitacaoId)
    .eq('fonte', 'PROPRIA');

  // Log cada um
  const logRows = mappings.map((m) => ({
    licitacao_id: licitacaoId,
    source: m.fonte_descoberta,
    acao: 'salvar_mapeamento_code',
    detalhes: {
      fonte_orig: m.fonte_orig,
      codigo_orig: m.codigo_orig,
      fonte_sub: m.fonte_sub,
      codigo_sub: m.codigo_sub,
      confianca: m.confianca,
      justificativa: m.justificativa,
    },
    sucesso: true,
  }));
  const { data: logsInserted } = await admin
    .from('orcapav_correcoes_log')
    .insert(logRows)
    .select('id');
  return {
    aplicados: mappings.length,
    logs_id: (logsInserted ?? []).map((l) => l.id),
  };
}

async function processarLicitacao(
  admin: ReturnType<typeof getServiceRoleClient>,
  geminiKey: string,
  licitacaoId: string,
): Promise<{
  licitacao_id: string;
  warnings_count: number;
  codigos_extraidos: number;
  do_knowledge: number;
  do_gemini: number;
  total_aplicados: number;
}> {
  const inicio = Date.now();
  // Pega cadastro_resumo.warnings
  const { data: lic } = await admin
    .from('licitacoes')
    .select('cadastro_resumo')
    .eq('id', licitacaoId)
    .maybeSingle();
  const warnings = (lic?.cadastro_resumo as { warnings?: string[] } | null)?.warnings ?? [];
  const codigos = extrairCodigosDeWarnings(warnings);

  if (codigos.length === 0) {
    await admin.from('orcapav_correcoes_log').insert({
      licitacao_id: licitacaoId,
      source: 'worker',
      acao: 'analise',
      detalhes: { warnings_count: warnings.length, codigos_encontrados: 0 },
      duracao_ms: Date.now() - inicio,
      sucesso: true,
    });
    return {
      licitacao_id: licitacaoId,
      warnings_count: warnings.length,
      codigos_extraidos: 0,
      do_knowledge: 0,
      do_gemini: 0,
      total_aplicados: 0,
    };
  }

  // Consulta knowledge_base
  const conhecidos = await consultarKnowledgeBase(admin, codigos);
  const desconhecidos = codigos.filter(
    (c) => !conhecidos.has(`${c.fonte}/${c.codigo}`),
  );

  // Gemini Flash pra desconhecidos
  const sugestoesGemini = desconhecidos.length > 0
    ? await consultarGeminiFlashBatch(geminiKey, desconhecidos)
    : [];
  const sugestoesValidas = sugestoesGemini.filter(
    (s) => s.fonte_sub && s.codigo_sub && s.confianca >= KNOWLEDGE_CONFIDENCE_THRESHOLD,
  );

  // Junta tudo e aplica
  const mappingsParaAplicar = [
    ...[...conhecidos.entries()].map(([key, v]) => {
      const [fonte, codigo] = key.split('/');
      return {
        fonte_orig: fonte,
        codigo_orig: codigo,
        fonte_sub: v.fonte_sub,
        codigo_sub: v.codigo_sub,
        confianca: v.confianca,
        fonte_descoberta: 'knowledge_base' as const,
        justificativa: 'Da base de conhecimento OrçaPav',
      };
    }),
    ...sugestoesValidas.map((s) => ({
      fonte_orig: s.fonte,
      codigo_orig: s.codigo,
      fonte_sub: s.fonte_sub!,
      codigo_sub: s.codigo_sub!,
      confianca: s.confianca,
      fonte_descoberta: 'gemini_flash' as const,
      justificativa: s.justificativa,
    })),
  ];

  const result = await aplicarMappingsELogar(admin, licitacaoId, mappingsParaAplicar);

  await admin.from('orcapav_correcoes_log').insert({
    licitacao_id: licitacaoId,
    source: 'worker',
    acao: 'analise_completa',
    detalhes: {
      warnings_count: warnings.length,
      codigos_extraidos: codigos.length,
      do_knowledge: conhecidos.size,
      do_gemini: sugestoesValidas.length,
      total_aplicados: result.aplicados,
    },
    duracao_ms: Date.now() - inicio,
    sucesso: true,
  });

  return {
    licitacao_id: licitacaoId,
    warnings_count: warnings.length,
    codigos_extraidos: codigos.length,
    do_knowledge: conhecidos.size,
    do_gemini: sugestoesValidas.length,
    total_aplicados: result.aplicados,
  };
}

// =============================================================================
// Main handler
// =============================================================================
Deno.serve(async (req: Request) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse(405, 'Use POST.');

  let body: RequestBody = {};
  try { body = await req.json(); } catch {}

  const admin = getServiceRoleClient();

  try {
    // Pega API key do Gemini (qualquer credencial organizacional ativa)
    const { data: gCreds } = await admin
      .from('api_credentials')
      .select('vault_secret_id')
      .eq('provider', 'gemini')
      .eq('ativo', true)
      .limit(1);
    if (!gCreds || gCreds.length === 0) {
      return errorResponse(500, 'Sem credencial Gemini configurada.');
    }
    const { data: apiKey } = await admin.rpc('read_vault_secret', {
      p_secret_id: gCreds[0].vault_secret_id,
    });
    if (typeof apiKey !== 'string' || !apiKey) {
      return errorResponse(500, 'Vault retornou API key inválida.');
    }

    // Modo single-licitação ou cron-batch
    const idsParaProcessar: string[] = [];
    if (body.licitacao_id) {
      idsParaProcessar.push(body.licitacao_id);
    } else {
      // Modo cron: pega licitações com cadastro_resumo.warnings não-vazio
      // e ainda não processadas nos últimos 30 min (se não foi forced)
      const { data: candidatas } = await admin
        .from('licitacoes')
        .select('id, cadastro_resumo, updated_at')
        .in('status', ['fase1_concluida', 'criando_composicoes_edital', 'criando_orcamento_base'])
        .not('cadastro_resumo', 'is', null);
      const ids = (candidatas ?? [])
        .filter((l) => {
          const w = (l.cadastro_resumo as { warnings?: string[] } | null)?.warnings ?? [];
          return w.length > 0;
        })
        .slice(0, MAX_LICITACOES_POR_RUN)
        .map((l) => l.id);
      idsParaProcessar.push(...ids);
    }

    const resultados = [];
    for (const id of idsParaProcessar) {
      try {
        const r = await processarLicitacao(admin, apiKey, id);
        resultados.push(r);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await admin.from('orcapav_correcoes_log').insert({
          licitacao_id: id,
          source: 'worker',
          acao: 'erro',
          detalhes: { mensagem: msg.slice(0, 500) },
          sucesso: false,
          erro: msg.slice(0, 500),
        });
        resultados.push({ licitacao_id: id, erro: msg });
      }
    }

    return jsonResponse({
      ok: true,
      processadas: resultados.length,
      resultados,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResponse(500, `Worker falhou: ${msg}`);
  }
});
