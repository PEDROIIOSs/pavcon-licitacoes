'use server';

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';

interface ActionResult {
  error?: string;
}

export async function createLicitacao(formData: FormData): Promise<ActionResult> {
  const titulo = String(formData.get('titulo') ?? '').trim();
  const file = formData.get('arquivo') as File | null;

  if (!titulo) return { error: 'Título é obrigatório.' };
  if (!file || file.size === 0) return { error: 'Selecione um PDF.' };
  if (file.type !== 'application/pdf') return { error: 'Apenas PDF é aceito.' };
  if (file.size > 100 * 1024 * 1024) return { error: 'Arquivo passa de 100 MB.' };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Não autenticado.' };

  // 1) Cria a licitação em rascunho
  const { data: licitacao, error: licErr } = await supabase
    .from('licitacoes')
    .insert({ titulo, criado_por: user.id, status: 'rascunho' })
    .select('id')
    .single();
  if (licErr || !licitacao) {
    return { error: `Falha ao criar licitação: ${licErr?.message ?? 'sem dado'}` };
  }

  // 2) Upload pra storage/editais/<licitacao_id>/<filename>
  const safeName = file.name.replace(/[^\w.-]+/g, '_');
  const storagePath = `${licitacao.id}/${Date.now()}_${safeName}`;
  const { error: uploadErr } = await supabase
    .storage
    .from('editais')
    .upload(storagePath, file, { contentType: 'application/pdf', upsert: false });
  if (uploadErr) {
    // Reverte a licitação criada — orfanada não serve
    await supabase.from('licitacoes').delete().eq('id', licitacao.id);
    return { error: `Falha no upload: ${uploadErr.message}` };
  }

  // 3) Hash do arquivo (idempotência futura)
  const buffer = new Uint8Array(await file.arrayBuffer());
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // 4) Cria licitacao_arquivos
  const { error: arqErr } = await supabase.from('licitacao_arquivos').insert({
    licitacao_id: licitacao.id,
    tipo: 'planilha_orcamentaria',
    storage_bucket: 'editais',
    storage_path: storagePath,
    filename_original: file.name,
    mime_type: file.type,
    size_bytes: file.size,
    hash_sha256: hashHex,
    enviado_por: user.id,
  });
  if (arqErr) {
    // Limpa o storage e a licitação
    await supabase.storage.from('editais').remove([storagePath]);
    await supabase.from('licitacoes').delete().eq('id', licitacao.id);
    return { error: `Falha ao registrar arquivo: ${arqErr.message}` };
  }

  // 5) Avança status: rascunho → aguardando_extracao
  await supabase
    .from('licitacoes')
    .update({ status: 'aguardando_extracao' })
    .eq('id', licitacao.id);

  redirect(`/licitacoes/${licitacao.id}`);
}
