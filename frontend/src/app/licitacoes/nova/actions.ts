'use server';

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { redirect } from 'next/navigation';

interface ActionResult {
  error?: string;
}

const TIPOS_VALIDOS = new Set([
  'planilha_orcamentaria',
  'memorial_descritivo',
  'projeto_tecnico',
  'edital',
  'anexo',
]);

export async function createLicitacao(formData: FormData): Promise<ActionResult> {
  const titulo = String(formData.get('titulo') ?? '').trim();
  const files = formData.getAll('arquivos') as File[];
  const tipos = formData.getAll('tipos').map(String);

  if (!titulo) return { error: 'Título é obrigatório.' };
  if (files.length === 0) return { error: 'Selecione pelo menos 1 PDF.' };
  if (files.length !== tipos.length) {
    return { error: 'Número de tipos não bate com número de arquivos.' };
  }

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (!f || f.size === 0) return { error: `Arquivo #${i + 1} vazio.` };
    if (f.type !== 'application/pdf') return { error: `"${f.name}" não é PDF.` };
    if (f.size > 100 * 1024 * 1024) return { error: `"${f.name}" passa de 100 MB.` };
    if (!TIPOS_VALIDOS.has(tipos[i])) {
      return { error: `Tipo "${tipos[i]}" inválido pra "${f.name}".` };
    }
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Não autenticado.' };

  const admin = createAdminClient();

  // 1) Cria a licitação em rascunho
  const { data: licitacao, error: licErr } = await admin
    .from('licitacoes')
    .insert({ titulo, criado_por: user.id, status: 'rascunho' })
    .select('id')
    .single();
  if (licErr || !licitacao) {
    return { error: `Falha ao criar orçamento: ${licErr?.message ?? 'sem dado'}` };
  }

  const uploadedPaths: string[] = [];

  // 2) Upload + 3) hash + 4) row em licitacao_arquivos — pra cada arquivo
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const tipo = tipos[i];
    const safeName = file.name.replace(/[^\w.-]+/g, '_');
    const storagePath = `${licitacao.id}/${Date.now()}_${i}_${safeName}`;

    const { error: uploadErr } = await supabase
      .storage
      .from('editais')
      .upload(storagePath, file, { contentType: 'application/pdf', upsert: false });
    if (uploadErr) {
      // Cleanup tudo
      if (uploadedPaths.length > 0) {
        await supabase.storage.from('editais').remove(uploadedPaths);
      }
      await admin.from('licitacoes').delete().eq('id', licitacao.id);
      return { error: `Falha no upload de "${file.name}": ${uploadErr.message}` };
    }
    uploadedPaths.push(storagePath);

    const buffer = new Uint8Array(await file.arrayBuffer());
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashHex = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    const { error: arqErr } = await admin.from('licitacao_arquivos').insert({
      licitacao_id: licitacao.id,
      tipo,
      storage_bucket: 'editais',
      storage_path: storagePath,
      filename_original: file.name,
      mime_type: file.type,
      size_bytes: file.size,
      hash_sha256: hashHex,
      enviado_por: user.id,
    });
    if (arqErr) {
      await supabase.storage.from('editais').remove(uploadedPaths);
      await admin.from('licitacoes').delete().eq('id', licitacao.id);
      return { error: `Falha ao registrar "${file.name}": ${arqErr.message}` };
    }
  }

  // 5) Avança status: rascunho → aguardando_extracao
  await admin
    .from('licitacoes')
    .update({ status: 'aguardando_extracao' })
    .eq('id', licitacao.id);

  redirect(`/licitacoes/${licitacao.id}`);
}
