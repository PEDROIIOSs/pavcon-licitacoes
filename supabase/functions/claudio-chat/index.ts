// =============================================================================
// Edge Function: claudio-chat
// =============================================================================
// Cláudio conversacional plugado com Claude API (Anthropic Messages API).
// Suporta tool use (function calling): Claude raciocina sobre o problema,
// chama ferramentas server-side pra executar auto-fixes determinísticos,
// e devolve resposta em linguagem natural com ações já aplicadas.
//
// Body:
//   {
//     licitacao_id: "uuid",
//     messages: [{role: "user"|"assistant", content: string}],
//     contexto?: {...}     // opcional, frontend pode pré-coletar
//   }
//
// Response (200):
//   {
//     ok: true,
//     resposta: "texto final do Cláudio",
//     acoes_executadas: [{tool: "executar_auto_fix", input: {...}, result: {...}}],
//     tokens_in, tokens_out
//   }
// =============================================================================

import { handleCorsPreflight } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/json.ts';
import { getServiceRoleClient, requireAuthenticatedUser } from '../_shared/supabase.ts';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-5-20250929';
const MAX_TOOL_LOOPS = 8;

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | unknown[];
}

interface RequestBody {
  licitacao_id?: string;
  messages?: ChatMessage[];
  contexto?: Record<string, unknown>;
}

// =============================================================================
// System prompt
// =============================================================================
const SYSTEM_PROMPT = `Você é o **Cláudio**, assistente especializado em orçamentos de licitação pública brasileira, plugado no sistema PavCon Licitações.

# Domínio técnico
- **Bancos públicos**: SINAPI (federal), SICRO3 (DNIT), ORSE (Sergipe), SEINFRA (Ceará), SEDOP (Pará), SBC (Bahia), SETOP, EMBASA, FDE, CPOS, SUDECAP, IOPES, AGESUL, EMOP, SCO, DERPR, CAEMA, CAERN, COMPESA, SIURB, AGETOP, MAPP.
- **Orçafascio**: software que usa códigos desses bancos. Códigos descontinuados ou adaptados pelo órgão retornam preço R$ 0,00 silenciosamente.
- **Regras de licitação**: BDI fixo do edital (não muda na proposta), desconto não incide sobre mão de obra, valor da proposta NUNCA pode ultrapassar o edital (desclassificação).
- **Composições adaptadas**: o órgão modifica a composição oficial — sufixos como \`-ADAP\`, \`-A\`, \`adaptado\`, ou texto literal \`COMPOSIÇÃO XX\` no código indicam adaptação. Devem ser tratadas como PROPRIA.

# Seu papel
1. Analisar contexto da licitação que vou te passar
2. Identificar problemas conhecidos
3. **Executar correções automaticamente** via tools quando disponível (não só sugerir — APLICAR)
4. Explicar em linguagem clara o que fez e qual o próximo passo
5. Quando não tiver ferramenta apropriada, ser específico no que o orçamentista precisa fazer manualmente

# Tom
- Direto, em português brasileiro
- Conciso (máximo 3 parágrafos)
- Empático com prazo apertado de licitação
- Vai direto pro ponto
- Use emojis com moderação: 🔍 análise, ✓ sucesso, ⚠️ alerta, 🤖 quando você aplica fix

# Sobre tools
- Quando o problema tiver auto-fix, CHAME a tool imediatamente — não pergunte permissão
- Após executar tools, **dê resposta consolidada** explicando o que aconteceu
- Se uma tool falhar, explique o erro e proponha alternativa`;

// =============================================================================
// Tools (function calling)
// =============================================================================
const TOOLS = [
  {
    name: 'executar_auto_fix',
    description:
      'Executa um auto-fix determinístico na licitação atual. Use quando o problema tem solução padronizada. ' +
      'Retorna mensagem + número de mudanças aplicadas.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: {
          type: 'string',
          enum: ['reclassificar_codes_adaptados', 'aplicar_mapeamentos_pendentes'],
          description:
            'reclassificar_codes_adaptados: converte items SINAPI/ORSE com sufixo -ADAP/COMPOSIÇÃO XX pra PROPRIA. ' +
            'aplicar_mapeamentos_pendentes: limpa MyBase IDs pra recriar com codes mapeados recentemente.',
        },
      },
      required: ['tipo'],
    },
  },
  {
    name: 'obter_estado_atual',
    description:
      'Retorna estado atualizado da licitação: status, total esperado, codes pendentes, diagnósticos. ' +
      'Use quando precisar de dados frescos depois de executar um fix ou quando o contexto inicial parecer desatualizado.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'consultar_codes_pendentes',
    description:
      'Lista os códigos descontinuados que estão pendentes de mapeamento. ' +
      'Use quando o usuário pedir pra ajudar com codes específicos ou listar pendências.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max codes a retornar (default 10)' },
      },
    },
  },
  {
    name: 'sugerir_mapeamento_code',
    description:
      'Salva um mapeamento de code antigo → code novo na tabela orcafascio_code_mappings. ' +
      'Use quando você (Cláudio) souber com confiança alta o código moderno equivalente ' +
      'baseado na descrição do item. Depois disso o orçamentista deve clicar "🚀 Cadastrar tudo" pra aplicar.',
    input_schema: {
      type: 'object',
      properties: {
        fonte_original: { type: 'string', description: 'Banco antigo (ex: SINAPI)' },
        codigo_original: { type: 'string', description: 'Código legacy (ex: 7696)' },
        fonte_substituto: { type: 'string', description: 'Banco novo (geralmente o mesmo)' },
        codigo_substituto: { type: 'string', description: 'Código moderno equivalente' },
        justificativa: { type: 'string', description: 'Por que esse é o equivalente correto' },
      },
      required: ['fonte_original', 'codigo_original', 'fonte_substituto', 'codigo_substituto', 'justificativa'],
    },
  },
];

// =============================================================================
// Tool execution
// =============================================================================
async function executarTool(
  toolName: string,
  input: Record<string, unknown>,
  ctx: { licitacaoId: string; userId: string; admin: ReturnType<typeof getServiceRoleClient> },
): Promise<unknown> {
  const { licitacaoId, userId, admin } = ctx;

  if (toolName === 'executar_auto_fix') {
    const tipo = input.tipo as string;
    if (tipo === 'reclassificar_codes_adaptados') {
      const { data: items } = await admin
        .from('composicoes_extraidas')
        .select('id, fonte, codigo, metadata')
        .eq('licitacao_id', licitacaoId)
        .eq('tipo_linha', 'servico');

      const ehAdaptado = (fonte: string | null, codigo: string | null) => {
        if (!codigo || !fonte) return null;
        const f = fonte.toUpperCase();
        if (f === 'PROPRIA' || f === 'OUTRA') return null;
        const c = codigo.toUpperCase().trim();
        if (/^COMPOSI[CÇ][ÃA]O\s*[\d_-]+/i.test(c)) return 'texto literal "COMPOSIÇÃO XX"';
        if (/[\s-]ADAPT?(?:AD[OA])?\s*$|^ADAPTAD[OA]\s|\sADAP\s|-A$|-ADAP$/i.test(c)) {
          return 'sufixo de adaptação';
        }
        return null;
      };
      const aReclassificar = (items ?? []).filter((it) => ehAdaptado(it.fonte, it.codigo));
      for (const it of aReclassificar) {
        const motivo = ehAdaptado(it.fonte, it.codigo);
        const metaAtual = (it.metadata as Record<string, unknown> | null) ?? {};
        await admin
          .from('composicoes_extraidas')
          .update({
            fonte: 'PROPRIA',
            orcafascio_composition_id: null,
            metadata: {
              ...metaAtual,
              fonte_original: it.fonte,
              codigo_original: it.codigo,
              reclassificada_motivo: motivo,
              reclassificada_em: new Date().toISOString(),
              reclassificada_por: 'claudio_chat',
            },
          })
          .eq('id', it.id);
      }
      return {
        ok: true,
        mudancas: aReclassificar.length,
        mensagem: `${aReclassificar.length} item(ns) reclassificado(s) pra PROPRIA. Próximo: clique "🚀 Cadastrar tudo no Orçafascio".`,
      };
    }
    if (tipo === 'aplicar_mapeamentos_pendentes') {
      const { count } = await admin
        .from('composicoes_extraidas')
        .update({ orcafascio_composition_id: null }, { count: 'exact' })
        .eq('licitacao_id', licitacaoId)
        .eq('fonte', 'PROPRIA')
        .not('orcafascio_composition_id', 'is', null);
      return {
        ok: true,
        mudancas: count ?? 0,
        mensagem: `${count ?? 0} composição(ões) marcada(s) pra recriação com mapeamentos novos.`,
      };
    }
    return { ok: false, erro: `tipo inválido: ${tipo}` };
  }

  if (toolName === 'obter_estado_atual') {
    const { data: licitacao } = await admin
      .from('licitacoes')
      .select('id, titulo, status, orcafascio_orcamento_base_id, cadastro_resumo')
      .eq('id', licitacaoId)
      .maybeSingle();

    const { data: agg } = await admin
      .from('composicoes_extraidas')
      .select('fonte, preco_total, tipo_linha')
      .eq('licitacao_id', licitacaoId);
    const total = (agg ?? [])
      .filter((a) => a.tipo_linha === 'servico')
      .reduce((s, a) => s + Number(a.preco_total ?? 0), 0);
    const porFonte: Record<string, number> = {};
    for (const a of agg ?? []) {
      if (a.tipo_linha !== 'servico') continue;
      const f = a.fonte ?? '(sem fonte)';
      porFonte[f] = (porFonte[f] ?? 0) + Number(a.preco_total ?? 0);
    }

    return {
      licitacao,
      total_edital_com_bdi: total,
      por_fonte: porFonte,
    };
  }

  if (toolName === 'consultar_codes_pendentes') {
    const limit = Math.min(Number(input.limit ?? 10), 50);
    const { data: composicoes } = await admin
      .from('composicoes_extraidas')
      .select('id')
      .eq('licitacao_id', licitacaoId)
      .eq('fonte', 'PROPRIA');
    const compIds = (composicoes ?? []).map((c) => c.id);
    if (compIds.length === 0) return { codes: [] };
    const { data: subs } = await admin
      .from('composicao_propria_itens')
      .select('codigo, fonte')
      .in('composicao_extraida_id', compIds);
    const setCodes = new Set(
      (subs ?? []).map((s) => `${(s.fonte ?? '').toUpperCase()}/${s.codigo ?? ''}`),
    );
    const { data: mappings } = await admin
      .from('orcafascio_code_mappings')
      .select('fonte_original, codigo_original, descricao')
      .is('codigo_substituto', null)
      .limit(limit);
    const codes = (mappings ?? []).filter((m) =>
      setCodes.has(`${(m.fonte_original ?? '').toUpperCase()}/${m.codigo_original ?? ''}`),
    );
    return { codes };
  }

  if (toolName === 'sugerir_mapeamento_code') {
    const fonteOrig = (input.fonte_original as string).toUpperCase();
    const codOrig = input.codigo_original as string;
    const fonteSubst = (input.fonte_substituto as string).toUpperCase();
    const codSubst = input.codigo_substituto as string;
    const just = (input.justificativa as string) ?? '';

    await admin.from('orcafascio_code_mappings').upsert({
      fonte_original: fonteOrig,
      codigo_original: codOrig,
      fonte_substituto: fonteSubst,
      codigo_substituto: codSubst,
      motivo: `Cláudio: ${just}`.slice(0, 500),
    }, { onConflict: 'fonte_original,codigo_original' });

    return {
      ok: true,
      mensagem: `Mapeamento ${fonteOrig}/${codOrig} → ${fonteSubst}/${codSubst} salvo.`,
    };
  }

  return { ok: false, erro: `tool desconhecida: ${toolName}` };
}

// =============================================================================
// Handler principal
// =============================================================================
Deno.serve(async (req: Request) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse(405, 'Use POST.');

  let body: RequestBody;
  try { body = await req.json(); } catch { return errorResponse(400, 'JSON inválido.'); }

  if (!body.licitacao_id) return errorResponse(400, 'licitacao_id obrigatório.');
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return errorResponse(400, 'messages obrigatório (array com pelo menos 1 mensagem).');
  }

  let userId: string;
  try {
    const u = await requireAuthenticatedUser(req);
    userId = u.id;
  } catch {
    return errorResponse(401, 'Não autenticado.');
  }

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return jsonResponse({
      ok: false,
      stub: true,
      resposta:
        'Oi, sou o Cláudio! 🤖\n\n' +
        'Ainda não fui plugado com a Claude API — o admin precisa configurar ' +
        '`ANTHROPIC_API_KEY` no Supabase. Enquanto isso, use o botão "🤖 Cláudio resolver agora" ' +
        'nos diagnósticos detectados pra eu aplicar auto-fixes determinísticos.',
    });
  }

  const admin = getServiceRoleClient();

  // Anexa contexto inicial à primeira mensagem do user como bloco invisível
  const contextoStr = body.contexto
    ? `\n\n<contexto_da_licitacao>${JSON.stringify(body.contexto)}</contexto_da_licitacao>`
    : '';

  const messages: Array<{ role: string; content: unknown }> = body.messages.map((m, i) => ({
    role: m.role,
    content: typeof m.content === 'string'
      ? (i === 0 && m.role === 'user' ? m.content + contextoStr : m.content)
      : m.content,
  }));

  const acoesExecutadas: Array<{ tool: string; input: unknown; result: unknown }> = [];
  let tokensIn = 0;
  let tokensOut = 0;

  // Tool use loop
  for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
    const resp = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return errorResponse(502, `Claude API ${resp.status}: ${errText.slice(0, 400)}`);
    }

    const data = await resp.json();
    tokensIn += data.usage?.input_tokens ?? 0;
    tokensOut += data.usage?.output_tokens ?? 0;

    // Adiciona resposta do assistente ao histórico
    messages.push({ role: 'assistant', content: data.content });

    if (data.stop_reason !== 'tool_use') {
      // Conversa terminou — extrai texto
      const text = (data.content as Array<{ type: string; text?: string }>)
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('\n')
        .trim();
      return jsonResponse({
        ok: true,
        resposta: text || '(Cláudio não respondeu nada)',
        acoes_executadas: acoesExecutadas,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        loops: loop + 1,
      });
    }

    // Executa cada tool_use e prepara tool_result pra próxima rodada
    const toolUses = (data.content as Array<{ type: string; id?: string; name?: string; input?: Record<string, unknown> }>)
      .filter((b) => b.type === 'tool_use');

    const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];
    for (const tu of toolUses) {
      try {
        const result = await executarTool(tu.name!, tu.input ?? {}, {
          licitacaoId: body.licitacao_id!,
          userId,
          admin,
        });
        acoesExecutadas.push({ tool: tu.name!, input: tu.input, result });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id!,
          content: JSON.stringify(result),
        });
      } catch (e) {
        const erro = e instanceof Error ? e.message : String(e);
        acoesExecutadas.push({ tool: tu.name!, input: tu.input, result: { erro } });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id!,
          content: JSON.stringify({ ok: false, erro }),
        });
      }
    }

    // Próxima rodada: adiciona tool_results como msg do user
    messages.push({ role: 'user', content: toolResults });
  }

  // Excedeu max loops
  return jsonResponse({
    ok: true,
    resposta: '(Excedi o limite de iterações. Tente reformular a pergunta.)',
    acoes_executadas: acoesExecutadas,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    loops: MAX_TOOL_LOOPS,
  });
});
