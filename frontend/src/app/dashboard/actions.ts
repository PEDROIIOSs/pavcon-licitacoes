'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireAdmin } from '@/lib/auth';

export async function deleteLicitacao(formData: FormData) {
  await requireAdmin();
  const licitacaoId = String(formData.get('licitacaoId') ?? '');

  if (!licitacaoId) {
    redirect(
      `/dashboard?error=${encodeURIComponent('licitacaoId ausente')}`,
    );
  }

  const admin = createAdminClient();

  // 1) PDFs no Storage (bucket 'editais')
  const { data: arquivos } = await admin
    .from('licitacao_arquivos')
    .select('storage_path')
    .eq('licitacao_id', licitacaoId);
  const paths = (arquivos ?? [])
    .map((a) => a.storage_path as string)
    .filter(Boolean);
  if (paths.length > 0) {
    await admin.storage.from('editais').remove(paths);
  }

  // 2) composicoes_extraidas — FK pra extracoes_ocr é NO ACTION, então
  //    precisa apagar ANTES de extracoes_ocr (idêntico ao import).
  const { error: e1 } = await admin
    .from('composicoes_extraidas')
    .delete()
    .eq('licitacao_id', licitacaoId);
  if (e1) {
    redirect(`/dashboard?error=${encodeURIComponent(`composicoes: ${e1.message}`)}`);
  }

  // 3) extracoes_ocr
  const { error: e2 } = await admin
    .from('extracoes_ocr')
    .delete()
    .eq('licitacao_id', licitacaoId);
  if (e2) {
    redirect(`/dashboard?error=${encodeURIComponent(`extracoes: ${e2.message}`)}`);
  }

  // 4) licitacao (CASCADE remove licitacao_arquivos)
  const { error: e3 } = await admin
    .from('licitacoes')
    .delete()
    .eq('id', licitacaoId);
  if (e3) {
    redirect(`/dashboard?error=${encodeURIComponent(`licitacoes: ${e3.message}`)}`);
  }

  revalidatePath('/dashboard');
  redirect('/dashboard?deleted=1');
}
