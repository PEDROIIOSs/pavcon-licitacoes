'use server';

import { createAdminClient } from '@/lib/supabase/admin';
import { requireAdmin } from '@/lib/auth';
import { revalidatePath } from 'next/cache';

export async function saveMapping(
  id: number,
  fonteSubstituto: string,
  codigoSubstituto: string,
): Promise<{ ok?: boolean; error?: string }> {
  await requireAdmin();
  const admin = createAdminClient();

  if (!fonteSubstituto.trim() || !codigoSubstituto.trim()) {
    return { error: 'Fonte e código substituto são obrigatórios.' };
  }

  const { error } = await admin
    .from('orcafascio_code_mappings')
    .update({
      fonte_substituto: fonteSubstituto.toUpperCase().trim(),
      codigo_substituto: codigoSubstituto.trim(),
    })
    .eq('id', id);

  if (error) return { error: error.message };

  revalidatePath('/dashboard/code-mappings');
  return { ok: true };
}

export async function deleteMapping(id: number): Promise<{ ok?: boolean; error?: string }> {
  await requireAdmin();
  const admin = createAdminClient();
  const { error } = await admin
    .from('orcafascio_code_mappings')
    .delete()
    .eq('id', id);
  if (error) return { error: error.message };
  revalidatePath('/dashboard/code-mappings');
  return { ok: true };
}
