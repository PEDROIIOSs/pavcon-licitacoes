'use server';

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { revalidatePath } from 'next/cache';

interface ActionResult {
  ok?: boolean;
  error?: string;
  details?: unknown;
}

export async function startExtraction(
  licitacaoId: string,
  _arquivoId: string | null,
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
    // Manda licitacao_id pra função processar TODOS os arquivos da licitação
    body: JSON.stringify({ licitacao_id: licitacaoId }),
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

  // Server-side: usa admin (service_role) pra contornar RLS nas tabelas
  // composicoes_extraidas e composicao_propria_itens, que são populadas
  // por Edge Functions. A autorização já foi validada (user autenticado
  // + dono da revisão; checagem extra abaixo via licitacao_id).
  const admin = createAdminClient();

  // 1) Salva json_corrigido + marca quem revisou
  const { error: extrErr } = await admin
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
  const { error: delErr } = await admin
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
    const { error: insErr } = await admin
      .from('composicoes_extraidas')
      .insert(composicoesRows);
    if (insErr) return { error: `Falha ao reinserir composições: ${insErr.message}` };
  }

  // 3) Re-insere os sub-itens das composições próprias
  const { data: persistidas, error: relerErr } = await admin
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
    const { error: subErr } = await admin
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

interface ImportarManualResult extends ActionResult {
  composicoes_inseridas?: number;
  sub_itens_inseridos?: number;
}

const SOURCE_LABELS: Record<string, { provider: 'gemini' | 'anthropic' | 'openai' | 'voyage' | 'orcafascio'; model: string }> = {
  notebooklm: { provider: 'gemini', model: 'gemini-2.5-pro (via NotebookLM — manual)' },
  claude_code: { provider: 'anthropic', model: 'claude (via Claude Code — manual)' },
  outro: { provider: 'gemini', model: 'desconhecido (manual)' },
};

interface ManualItem {
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

interface ManualJson {
  cabecalho: Record<string, unknown>;
  itens: ManualItem[];
}

function validateManualJson(raw: unknown): ManualJson {
  if (!raw || typeof raw !== 'object') throw new Error('JSON deve ser um objeto.');
  const o = raw as Record<string, unknown>;
  if (!o.cabecalho || typeof o.cabecalho !== 'object') {
    throw new Error('Faltou "cabecalho" no JSON.');
  }
  if (!Array.isArray(o.itens)) {
    throw new Error('"itens" deve ser um array.');
  }
  for (let i = 0; i < o.itens.length; i++) {
    const it = o.itens[i] as Partial<ManualItem>;
    if (!it.item_codigo) throw new Error(`Item #${i}: faltou item_codigo.`);
    if (typeof it.nivel !== 'number') throw new Error(`Item ${it.item_codigo}: nivel deve ser número.`);
    if (it.tipo !== 'grupo' && it.tipo !== 'servico') {
      throw new Error(`Item ${it.item_codigo}: tipo deve ser "grupo" ou "servico".`);
    }
    if (!it.descricao) throw new Error(`Item ${it.item_codigo}: faltou descricao.`);
  }
  return o as unknown as ManualJson;
}

function stripCodeFences(s: string): string {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  return m ? m[1].trim() : s.trim();
}

export async function importarExtracaoManual(
  licitacaoId: string,
  jsonText: string,
  source: 'notebooklm' | 'claude_code' | 'outro',
): Promise<ImportarManualResult> {
  const t0 = Date.now();
  try {
  console.log('[importar] start', { licitacaoId, source, jsonLen: jsonText.length });
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  console.log('[importar] auth', { ms: Date.now() - t0, userId: user?.id });
  if (!user) return { error: 'Não autenticado.' };

  // Parse + validate
  let parsed: ManualJson;
  try {
    const cleaned = stripCodeFences(jsonText);
    parsed = validateManualJson(JSON.parse(cleaned));
    console.log('[importar] parsed', { ms: Date.now() - t0, itens: parsed.itens.length });
  } catch (e) {
    return { error: `JSON inválido: ${e instanceof Error ? e.message : String(e)}` };
  }

  const admin = createAdminClient();

  // Verifica licitação
  const { data: licitacao, error: licErr } = await admin
    .from('licitacoes')
    .select('id, status')
    .eq('id', licitacaoId)
    .maybeSingle();
  if (licErr || !licitacao) return { error: 'Licitação não encontrada.' };
  const ALLOWED = new Set(['rascunho', 'aguardando_extracao', 'aguardando_revisao_humana', 'erro']);
  if (!ALLOWED.has(licitacao.status)) {
    return { error: `Licitação está em "${licitacao.status}", precisa estar em rascunho/aguardando_extracao/aguardando_revisao_humana/erro.` };
  }

  // Pega o primeiro arquivo da licitação pra referenciar na extração
  const { data: arquivos } = await admin
    .from('licitacao_arquivos')
    .select('id')
    .eq('licitacao_id', licitacaoId)
    .order('created_at')
    .limit(1);
  const arquivoId = arquivos?.[0]?.id;
  if (!arquivoId) {
    return { error: 'Suba pelo menos um arquivo antes de importar o JSON.' };
  }

  // Limpa extrações antigas dessa licitação
  await admin.from('extracoes_ocr').delete().eq('licitacao_id', licitacaoId);
  console.log('[importar] cleared old extracoes', { ms: Date.now() - t0 });

  // Cria extração
  const meta = SOURCE_LABELS[source] ?? SOURCE_LABELS.outro;
  const { data: extr, error: extrErr } = await admin
    .from('extracoes_ocr')
    .insert({
      licitacao_id: licitacaoId,
      arquivo_id: arquivoId,
      llm_provider: meta.provider,
      llm_model: meta.model,
      prompt_versao: 'pavcon-extracao-edital-v1',
      status: 'sucesso',
      json_extraido: parsed,
      tokens_input: 0,
      tokens_output: 0,
      custo_usd: 0,
      duracao_ms: 0,
      concluido_em: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (extrErr || !extr) {
    console.error('[importar] extracao_ocr insert FAILED', extrErr);
    return { error: `Falha ao criar extracao_ocr: ${extrErr?.message}` };
  }
  const extracaoId = extr.id as string;
  console.log('[importar] extracao_ocr created', { ms: Date.now() - t0, extracaoId });

  // Insere composicoes_extraidas
  const compRows = parsed.itens.map((item, idx) => ({
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
  const { data: persistidas, error: cErr } = await admin
    .from('composicoes_extraidas')
    .insert(compRows)
    .select('id, item_codigo');
  if (cErr || !persistidas) {
    console.error('[importar] composicoes_extraidas insert FAILED', cErr);
    return { error: `Falha ao gravar composicoes_extraidas: ${cErr?.message}` };
  }
  const idByCodigo = new Map(persistidas.map((c) => [c.item_codigo as string, c.id as string]));
  console.log('[importar] composicoes inseridas', {
    ms: Date.now() - t0,
    count: persistidas.length,
  });

  // Insere composicao_propria_itens
  const subRows: Array<Record<string, unknown>> = [];
  for (const item of parsed.itens) {
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
    const { error: subErr } = await admin
      .from('composicao_propria_itens')
      .insert(subRows);
    if (subErr) {
      console.error('[importar] composicao_propria_itens insert FAILED', subErr);
      return { error: `Falha ao gravar sub-itens: ${subErr.message}` };
    }
    console.log('[importar] sub-itens inseridos', {
      ms: Date.now() - t0,
      count: subRows.length,
    });
  }

  // Transições: rascunho/aguardando_extracao → extraindo → extracao_concluida → aguardando_revisao_humana
  if (licitacao.status === 'rascunho') {
    await admin.from('licitacoes').update({ status: 'aguardando_extracao' }).eq('id', licitacaoId);
  }
  if (['rascunho', 'aguardando_extracao'].includes(licitacao.status)) {
    await admin.from('licitacoes').update({ status: 'extraindo' }).eq('id', licitacaoId);
    await admin.from('licitacoes').update({ status: 'extracao_concluida' }).eq('id', licitacaoId);
  }
  await admin
    .from('licitacoes')
    .update({ status: 'aguardando_revisao_humana' })
    .eq('id', licitacaoId);
  console.log('[importar] status final', { ms: Date.now() - t0 });

  revalidatePath(`/licitacoes/${licitacaoId}`);
  console.log('[importar] done', {
    ms: Date.now() - t0,
    comps: compRows.length,
    subs: subRows.length,
  });

  return {
    ok: true,
    composicoes_inseridas: compRows.length,
    sub_itens_inseridos: subRows.length,
  };
  } catch (e) {
    console.error('[importar] uncaught', { ms: Date.now() - t0, err: e });
    return { error: `Erro interno: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function cadastrarNoOrcafascio(
  licitacaoId: string,
): Promise<ActionResult & {
  grupo_descricao?: string;
  composicoes_criadas?: number;
  composicoes_puladas?: number;
  itens_adicionados?: number;
  warnings?: string[];
}> {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Não autenticado.' };

  // Pega a credencial Orçafascio ativa (auth_type='api')
  const { data: creds, error: credErr } = await supabase
    .from('api_credentials')
    .select('id, metadata')
    .eq('provider', 'orcafascio')
    .eq('ativo', true);
  if (credErr) return { error: `Falha ao listar credenciais: ${credErr.message}` };
  const cred = (creds ?? []).find(
    (c) => (c.metadata as { auth_type?: string } | null)?.auth_type === 'api',
  );
  if (!cred) {
    return {
      error: 'Nenhuma credencial Orçafascio com auth_type="api" cadastrada. Cadastre uma no Vault primeiro.',
    };
  }

  const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/orcafascio-cadastrar-edital`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      licitacao_id: licitacaoId,
      credential_id: cred.id,
    }),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text); } catch {}

  revalidatePath(`/licitacoes/${licitacaoId}`);

  if (!res.ok) {
    return {
      error: `Cadastro falhou (${res.status}): ${(body.error as string) ?? text.slice(0, 200)}`,
      details: body.details ?? null,
    };
  }

  return {
    ok: true,
    grupo_descricao: body.grupo_descricao as string | undefined,
    composicoes_criadas: body.composicoes_criadas as number | undefined,
    composicoes_puladas: body.composicoes_puladas as number | undefined,
    itens_adicionados: body.itens_adicionados as number | undefined,
    warnings: body.warnings as string[] | undefined,
  };
}

export async function cadastrarOrcamentoCompleto(
  licitacaoId: string,
): Promise<ActionResult & {
  budget_id?: string;
  budget_url?: string;
  etapas_criadas?: number;
  composicoes_criadas?: number;
  total_itens_batch?: number;
  bdi?: number;
  leis_sociais_horista?: number;
  bancos_configurados?: string[];
  warnings?: string[];
}> {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Não autenticado.' };

  // Busca a credencial WEB (auth_type='web') — diferente da API (auth_type='api')
  const { data: creds, error: credErr } = await supabase
    .from('api_credentials')
    .select('id, metadata')
    .eq('provider', 'orcafascio')
    .eq('ativo', true);
  if (credErr) return { error: `Falha ao listar credenciais: ${credErr.message}` };
  const cred = (creds ?? []).find(
    (c) => (c.metadata as { auth_type?: string } | null)?.auth_type === 'web',
  );
  if (!cred) {
    return {
      error: 'Nenhuma credencial Orçafascio com auth_type="web" cadastrada. Cadastre a senha do Orçafascio no Vault primeiro.',
    };
  }

  const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/orcafascio-cadastrar-orcamento`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ licitacao_id: licitacaoId, credential_id: cred.id }),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text); } catch {}

  revalidatePath(`/licitacoes/${licitacaoId}`);

  if (!res.ok) {
    return {
      error: `Cadastro do orçamento falhou (${res.status}): ${(body.error as string) ?? text.slice(0, 300)}`,
      details: body.details ?? null,
    };
  }

  return {
    ok: true,
    budget_id: body.budget_id as string | undefined,
    budget_url: body.budget_url as string | undefined,
    etapas_criadas: body.etapas_criadas as number | undefined,
    composicoes_criadas: body.composicoes_criadas as number | undefined,
    total_itens_batch: body.total_itens_batch as number | undefined,
    bdi: body.bdi as number | undefined,
    leis_sociais_horista: body.leis_sociais_horista as number | undefined,
    bancos_configurados: body.bancos_configurados as string[] | undefined,
    warnings: body.warnings as string[] | undefined,
  };
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
