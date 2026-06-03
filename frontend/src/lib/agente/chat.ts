'use server';

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { env } from '@/lib/env';
import { revalidatePath } from 'next/cache';

export interface ChatMensagem {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

export interface ChatResultado {
  ok?: boolean;
  error?: string;
  resposta?: string;
  acoes_executadas?: Array<{ tool: string; input: unknown; result: unknown }>;
  stub?: boolean;
  tokens_in?: number;
  tokens_out?: number;
}

/**
 * Conversa com o Cláudio. Envia histórico + nova pergunta pra Edge Function
 * claudio-chat (que plugou com Claude API + tool use).
 *
 * O frontend mantém o histórico em state e re-envia a cada turn.
 */
export async function chatComClaudio(
  licitacaoId: string,
  historico: ChatMensagem[],
  novaPergunta: string,
): Promise<ChatResultado> {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Não autenticado.' };

  // Coleta contexto fresco da licitação pra dar pro Cláudio
  const admin = createAdminClient();
  const { data: licitacao } = await admin
    .from('licitacoes')
    .select('id, titulo, status, orcafascio_orcamento_base_id, cadastro_resumo')
    .eq('id', licitacaoId)
    .maybeSingle();

  const { data: extr } = await admin
    .from('extracoes_ocr')
    .select('json_corrigido, json_extraido')
    .eq('licitacao_id', licitacaoId)
    .in('status', ['sucesso', 'revisada_humano'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const cabecalho = ((extr?.json_corrigido ?? extr?.json_extraido) as
    { cabecalho?: Record<string, unknown> } | null)?.cabecalho;

  const { data: diagnosticos } = await admin
    .from('agente_diagnosticos')
    .select('tipo, severidade, titulo, mensagem, contexto')
    .eq('licitacao_id', licitacaoId)
    .eq('status', 'pendente');

  const contexto = {
    licitacao: {
      id: licitacao?.id,
      titulo: licitacao?.titulo,
      status: licitacao?.status,
      tem_orcamento: !!licitacao?.orcafascio_orcamento_base_id,
    },
    cabecalho,
    diagnosticos_pendentes: diagnosticos ?? [],
  };

  const messages = [
    ...historico.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: novaPergunta },
  ];

  const url = `${env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/claudio-chat`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        licitacao_id: licitacaoId,
        messages,
        contexto,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      return { error: `OrçaPav AI falhou (${res.status}): ${data?.error ?? 'erro desconhecido'}` };
    }
    revalidatePath(`/licitacoes/${licitacaoId}`);
    return data as ChatResultado;
  } catch (e) {
    return { error: `Falha de rede: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// =============================================================================
// AUTO-CORREÇÃO TOTAL — OrçaPav AI roda em loop até zerar erros
// =============================================================================
/**
 * Dispara o OrçaPav AI em modo "autônomo agressivo":
 *   1. Coleta TODOS os diagnósticos + warnings + erros conhecidos
 *   2. Manda pro Claude com instrução explícita "use TODAS as ferramentas que
 *      precisar, NÃO peça permissão, APLIQUE os fixes diretamente"
 *   3. O Edge Function já tem loop interno de tool use (MAX_TOOL_LOOPS=8) que
 *      executa correções em cadeia
 *   4. Retorna o relatório final + ações executadas
 *
 * Goal: orçamentista clica 1 botão e o sistema arruma tudo que dá pra arrumar
 * sozinho. Erros que precisam de input humano viram instruções claras na
 * resposta.
 */
/**
 * Dispara o WORKER autônomo do OrçaPav AI — usa base de conhecimento
 * (orcapav_knowledge_codes) com 24+ mappings pré-cadastrados, e Gemini
 * Flash só pra códigos desconhecidos. Auto-aprende.
 *
 * Retorno tem formato compatível com ChatResultado pra reuso da UI.
 */
export async function dispararAgenteOrcapav(licitacaoId: string): Promise<ChatResultado & {
  resultados?: Array<{
    licitacao_id: string;
    warnings_count?: number;
    codigos_extraidos?: number;
    do_knowledge?: number;
    do_gemini?: number;
    total_aplicados?: number;
  }>;
}> {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Não autenticado.' };

  const url = `${env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/orcapav-worker`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ licitacao_id: licitacaoId }),
    });
    const data = await res.json();
    if (!res.ok) {
      return { error: `Worker falhou (${res.status}): ${data?.error ?? 'erro desconhecido'}` };
    }
    revalidatePath(`/licitacoes/${licitacaoId}`);

    const r = (data.resultados ?? [])[0];
    const resposta = r
      ? `✓ ${r.total_aplicados ?? 0} código(s) mapeado(s) — ${r.do_knowledge ?? 0} da base de conhecimento, ${r.do_gemini ?? 0} do Gemini Flash. ` +
        `Total de códigos extraídos das ${r.warnings_count} warnings: ${r.codigos_extraidos}.`
      : 'Nenhuma licitação processada.';

    return {
      ok: true,
      resposta,
      acoes_executadas: r ? [{ tool: 'orcapav_worker', input: { licitacaoId }, result: r }] : [],
      resultados: data.resultados,
    };
  } catch (e) {
    return { error: `Falha de rede (worker): ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Auto-correção via Gemini Flash (alternativa gratuita ao Claude).
 * Usa orcapav-corrigir-gemini Edge Function com function calling nativo.
 */
async function autoCorrigirComGemini(licitacaoId: string): Promise<ChatResultado> {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Não autenticado.' };

  const url = `${env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/orcapav-corrigir-gemini`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ licitacao_id: licitacaoId }),
    });
    const data = await res.json();
    if (!res.ok) {
      return { error: `Gemini Flash falhou (${res.status}): ${data?.error ?? 'erro desconhecido'}` };
    }
    revalidatePath(`/licitacoes/${licitacaoId}`);
    return data as ChatResultado;
  } catch (e) {
    return { error: `Falha de rede (Gemini): ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function autoCorrigirComIA(
  licitacaoId: string,
): Promise<ChatResultado> {
  const prompt = `Tarefa: AUTO-CORREÇÃO TOTAL desta licitação.

Você é o OrçaPav AI rodando em modo autônomo. Sua missão:

1. Olhe TODOS os diagnósticos pendentes que vou te passar no contexto.
2. Pra CADA UM que tem ferramenta apropriada, EXECUTE a tool imediatamente — não me pergunte permissão, não explique antes de fazer, apenas FAÇA.
3. Use \`obter_estado_atual\` se precisar re-conferir depois de aplicar fixes.
4. Pra códigos descontinuados (SINAPI/ORSE/SEINFRA antigos), USE \`sugerir_mapeamento_code\` com seu melhor palpite sobre o equivalente moderno baseado na descrição do item. Confiança alta? Aplica. Médio-baixa? Pule e marque pra revisão humana.
5. Pra códigos com sufixo -ADAP/-A ou "COMPOSIÇÃO XX" mal classificados, use \`executar_auto_fix\` com tipo \`reclassificar_codes_adaptados\`.

Quando terminar todas as ações possíveis, devolva um relatório com:
- ✓ Quantas correções aplicadas (e quais)
- ⚠ Quantos erros precisam ação humana (e o que o orçamentista deve fazer pra cada)

Seja conciso. Nada de bla-bla-bla. Vai.`;

  // historico vazio — esta é uma sessão one-shot
  // Tenta Claude (Sonnet 4.5) primeiro. Se falhar com "credit balance too low"
  // ou outro erro 4xx da Anthropic, cai pro Gemini Flash (grátis/barato).
  const rClaude = await chatComClaudio(licitacaoId, [], prompt);
  if (rClaude.error) {
    const isCreditError = /credit|balance|billing|invalid_request_error/i.test(rClaude.error);
    if (isCreditError) {
      // Fallback transparente pro Gemini
      const rGemini = await autoCorrigirComGemini(licitacaoId);
      if (rGemini.error) {
        return { error: `Claude falhou (créditos?) e Gemini também: ${rGemini.error}` };
      }
      return { ...rGemini, resposta: `[via Gemini Flash — Claude sem créditos]\n\n${rGemini.resposta ?? ''}` };
    }
  }
  return rClaude;
}
