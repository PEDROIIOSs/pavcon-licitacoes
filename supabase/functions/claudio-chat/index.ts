// =============================================================================
// Edge Function: claudio-chat
// =============================================================================
// Cláudio conversacional — plugado com Claude API (Anthropic) pra
// raciocinar sobre a licitação e propor/aplicar correções em linguagem
// natural.
//
// Body:
//   {
//     "licitacao_id": "uuid",
//     "pergunta": "string",          // pergunta do orçamentista
//     "contexto"?: {                  // contexto coletado pelo frontend
//       diagnosticos: [...],
//       codesPendentes: [...],
//       cabecalho: {...}
//     }
//   }
//
// Auth: o ANTHROPIC_API_KEY fica no Supabase Vault (secret), buscado por
// nome `anthropic_api_key`. Pra ativar, o admin deve:
//   1. supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//   2. Deploy: supabase functions deploy claudio-chat
//
// =============================================================================

import { handleCorsPreflight } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/json.ts';
import { requireAuthenticatedUser } from '../_shared/supabase.ts';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-5-20250929';

interface RequestBody {
  licitacao_id?: string;
  pergunta?: string;
  contexto?: Record<string, unknown>;
}

// System prompt — define a persona e capacidades do Cláudio.
const SYSTEM_PROMPT = `Você é o Cláudio, assistente especializado em orçamentos de licitação pública brasileira plugado no sistema PavCon Licitações.

DOMÍNIO TÉCNICO QUE VOCÊ DOMINA:
- Bancos públicos: SINAPI (federal), SICRO3 (DNIT), ORSE (Sergipe), SEINFRA (Ceará), SEDOP (Pará), SBC (Bahia), etc
- Orçafascio: software de orçamento que usa códigos desses bancos. Códigos descontinuados ou adaptados pelo órgão retornam preço R$ 0,00 silenciosamente.
- Regras de licitação: BDI fixo no edital (não muda na proposta), desconto não incide sobre mão de obra, valor da proposta NUNCA pode ultrapassar o edital (desclassificação).
- Composições próprias (PROPRIA): adaptações dos bancos públicos feitas pelo órgão. Aparecem com sufixos como "-ADAP", "-A", "adaptado" ou texto literal "COMPOSIÇÃO XX".

SEU PAPEL:
1. Analisar o contexto da licitação que o orçamentista te enviar
2. Identificar problemas conhecidos (codes legacy, composições adaptadas mal classificadas, planilhas anexas faltando, etc)
3. Propor uma solução em linguagem natural, clara e acionável
4. Quando puder aplicar correção automaticamente via ferramentas disponíveis, dizer exatamente qual ferramenta e por quê
5. Aprender com correções confirmadas pelo orçamentista

FERRAMENTAS DISPONÍVEIS QUE VOCÊ PODE SUGERIR EXECUTAR:
- reclassificar_codes_adaptados: pega items SINAPI/ORSE com sufixo "-ADAP" e converte pra PROPRIA
- aplicar_mapeamentos_pendentes: limpa MyBase IDs pra recriar com codes mapeados
- abrir_painel_mapeamentos: link pra /dashboard/code-mappings
- voltar_pra_revisao: reset suave que mantém JSON mas permite re-editar

TOM:
- Direto, em português brasileiro
- Conciso (máximo 3 parágrafos curtos)
- Empático com o orçamentista que está sob pressão de prazos
- Sem rodeios — vai direto pro ponto e propõe a próxima ação
- Use emojis com moderação (🔍 pra análise, ✓ pra sucesso, ⚠️ pra alertas)`;

Deno.serve(async (req: Request) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;

  if (req.method !== 'POST') {
    return errorResponse(405, 'Use POST.');
  }

  let body: RequestBody;
  try { body = await req.json(); }
  catch { return errorResponse(400, 'JSON inválido.'); }

  if (!body.licitacao_id) return errorResponse(400, 'licitacao_id obrigatório.');
  if (!body.pergunta?.trim()) return errorResponse(400, 'pergunta obrigatória.');

  try {
    await requireAuthenticatedUser(req);
  } catch {
    return errorResponse(401, 'Não autenticado.');
  }

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    // Stub mode: avisa o orçamentista que precisa configurar
    return jsonResponse({
      ok: false,
      stub: true,
      mensagem:
        'O Cláudio conversacional ainda não foi plugado com a Claude API. ' +
        'Pra ativar, o admin precisa configurar ANTHROPIC_API_KEY como secret no Supabase: ' +
        '`supabase secrets set ANTHROPIC_API_KEY=sk-ant-... --project-ref cwgjjjlyccgivscngzgz`. ' +
        'Enquanto isso, use os auto-fixes determinísticos (botão "🤖 Cláudio resolver agora") que ' +
        'cobrem os padrões conhecidos.',
    }, 200);
  }

  // Chama Claude API
  try {
    const resp = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: [{
            type: 'text',
            text: `Contexto da licitação:\n${JSON.stringify(body.contexto ?? {}, null, 2)}\n\nPergunta do orçamentista:\n${body.pergunta}`,
          }],
        }],
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      return errorResponse(502, `Claude API erro ${resp.status}: ${errText.slice(0, 300)}`);
    }
    const data = await resp.json();
    const textContent = (data.content as Array<{ type: string; text?: string }>)
      ?.filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n');
    return jsonResponse({
      ok: true,
      resposta: textContent,
      modelo: MODEL,
      tokens_in: data.usage?.input_tokens,
      tokens_out: data.usage?.output_tokens,
    });
  } catch (e) {
    return errorResponse(
      500,
      `Falha ao chamar Claude: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
});
