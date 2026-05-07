'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

interface ActionResult {
  ok?: boolean;
  error?: string;
  details?: unknown;
}

export async function startExtraction(
  licitacaoId: string,
  arquivoId: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return { error: 'Não autenticado.' };

  const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/extracao-edital`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ arquivo_id: arquivoId }),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  revalidatePath(`/licitacoes/${licitacaoId}`);

  if (!res.ok) {
    return { error: `Extração falhou (${res.status})`, details: body };
  }
  return { ok: true };
}

export async function saveExtractionEdits(
  licitacaoId: string,
  extracaoId: string,
  jsonCorrigido: { cabecalho: Record<string, unknown>; itens: ExtractedItem[] },
): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Não autenticado.' };

  // 1) Salva json_corrigido + marca quem revisou
  const { error: extrErr } = await supabase
    .from('extracoes_ocr')
    .update({
      json_corrigido: jsonCorrigido,
      status: 'revisada_humano',
      revisado_por: user.id,
      revisado_em: new Date().toISOString(),
    })
    .eq('id', extracaoId)
    .eq('licitacao_id', licitacaoId);
  if (extrErr) return { error: `Falha ao salvar revisão: ${extrErr.message}` };

  // 2) Re-popula composicoes_extraidas (cascade limpa composicao_propria_itens)
  const { error: delErr } = await supabase
    .from('composicoes_extraidas')
    .delete()
    .eq('licitacao_id', licitacaoId)
    .eq('extracao_id', extracaoId);
  if (delErr) return { error: `Falha ao limpar composições antigas: ${delErr.message}` };

  const composicoesRows = jsonCorrigido.itens.map((item, idx) => ({
    licitacao_id: licitacaoId,
    extracao_id: extracaoId,
    item_codigo: item.item_codigo,
    item_nivel: item.nivel,
    item_pai_codigo: item.pai,
    tipo_linha: item.tipo,
    codigo: item.codigo,
    fonte: item.fonte,
    descricao: item.descricao,
    unidade: item.unidade,
    quantidade: item.quantidade,
    preco_unitario_sem_bdi: item.preco_unitario_sem_bdi,
    preco_unitario_com_bdi: item.preco_unitario_com_bdi,
    preco_total: item.preco_total,
    ordem: idx,
    metadata: {},
  }));

  if (composicoesRows.length > 0) {
    const { error: insErr } = await supabase
      .from('composicoes_extraidas')
      .insert(composicoesRows);
    if (insErr) return { error: `Falha ao reinserir composições: ${insErr.message}` };
  }

  // 3) Re-insere os sub-itens das composições próprias
  const { data: persistidas, error: relerErr } = await supabase
    .from('composicoes_extraidas')
    .select('id, item_codigo')
    .eq('licitacao_id', licitacaoId)
    .eq('extracao_id', extracaoId);
  if (relerErr || !persistidas) {
    return { error: 'Falha ao reler composições.' };
  }
  const idByCodigo = new Map(persistidas.map((c) => [c.item_codigo, c.id]));

  const subRows: Array<Record<string, unknown>> = [];
  for (const item of jsonCorrigido.itens) {
    if (item.fonte !== 'PROPRIA' || !item.composicao_propria?.itens) continue;
    const compId = idByCodigo.get(item.item_codigo);
    if (!compId) continue;
    item.composicao_propria.itens.forEach((sub, i) => {
      subRows.push({
        composicao_extraida_id: compId,
        classe: sub.classe,
        codigo: sub.codigo ?? null,
        fonte: sub.fonte,
        descricao: sub.descricao,
        unidade: sub.unidade ?? null,
        coeficiente: sub.coeficiente,
        preco_unitario: sub.preco_unitario ?? null,
        preco_total: sub.preco_unitario != null
          ? sub.coeficiente * sub.preco_unitario
          : null,
        ordem: i,
      });
    });
  }
  if (subRows.length > 0) {
    const { error: subErr } = await supabase
      .from('composicao_propria_itens')
      .insert(subRows);
    if (subErr) return { error: `Falha ao gravar sub-itens: ${subErr.message}` };
  }

  revalidatePath(`/licitacoes/${licitacaoId}`);
  return { ok: true };
}

export async function approveExtraction(
  licitacaoId: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  // Transição: aguardando_revisao_humana → criando_composicoes_edital
  // (é o próximo estado válido segundo a state machine)
  const { error } = await supabase
    .from('licitacoes')
    .update({ status: 'criando_composicoes_edital' })
    .eq('id', licitacaoId)
    .eq('status', 'aguardando_revisao_humana');
  if (error) return { error: error.message };

  revalidatePath(`/licitacoes/${licitacaoId}`);
  return { ok: true };
}

export async function resetToDraft(licitacaoId: string): Promise<ActionResult> {
  // Útil quando a extração falha: zerar pra rascunho e tentar de novo.
  const supabase = await createClient();
  const { error } = await supabase
    .from('licitacoes')
    .update({ status: 'rascunho' })
    .eq('id', licitacaoId);
  if (error) return { error: error.message };
  revalidatePath(`/licitacoes/${licitacaoId}`);
  return { ok: true };
}

// Tipo compartilhado com a página
export interface ExtractedItem {
  item_codigo: string;
  nivel: number;
  pai: string | null;
  tipo: 'grupo' | 'servico';
  codigo: string | null;
  fonte: string | null;
  descricao: string;
  unidade: string | null;
  quantidade: number | null;
  preco_unitario_sem_bdi: number | null;
  preco_unitario_com_bdi: number | null;
  preco_total: number | null;
  composicao_propria?: {
    itens: Array<{
      classe: string;
      codigo: string | null;
      fonte: string;
      descricao: string;
      unidade: string | null;
      coeficiente: number;
      preco_unitario: number | null;
    }>;
  };
}
