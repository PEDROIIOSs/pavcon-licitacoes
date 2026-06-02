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
      return { error: `Cláudio falhou (${res.status}): ${data?.error ?? 'erro desconhecido'}` };
    }
    revalidatePath(`/licitacoes/${licitacaoId}`);
    return data as ChatResultado;
  } catch (e) {
    return { error: `Falha de rede: ${e instanceof Error ? e.message : String(e)}` };
  }
}
