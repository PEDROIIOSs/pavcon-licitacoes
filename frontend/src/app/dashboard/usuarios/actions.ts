'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireAdmin } from '@/lib/auth';

export async function createUser(formData: FormData) {
  await requireAdmin();

  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const password = String(formData.get('password') ?? '');

  if (!email || !password) {
    redirect(
      `/dashboard/usuarios?error=${encodeURIComponent('Email e senha são obrigatórios')}`,
    );
  }
  if (password.length < 8) {
    redirect(
      `/dashboard/usuarios?error=${encodeURIComponent('Senha precisa ter pelo menos 8 caracteres')}`,
    );
  }

  const admin = createAdminClient();
  const { error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // pula confirmação por email — usuário já entra logado
  });

  if (error) {
    redirect(
      `/dashboard/usuarios?error=${encodeURIComponent(error.message)}`,
    );
  }
  revalidatePath('/dashboard/usuarios');
  redirect(`/dashboard/usuarios?created=${encodeURIComponent(email)}`);
}

export async function updateUserPassword(formData: FormData) {
  await requireAdmin();

  const userId = String(formData.get('userId') ?? '');
  const password = String(formData.get('password') ?? '');

  if (!userId) {
    redirect(
      `/dashboard/usuarios?error=${encodeURIComponent('userId ausente')}`,
    );
  }
  if (password.length < 8) {
    redirect(
      `/dashboard/usuarios?error=${encodeURIComponent('Senha precisa ter pelo menos 8 caracteres')}`,
    );
  }

  const admin = createAdminClient();
  const { error } = await admin.auth.admin.updateUserById(userId, { password });
  if (error) {
    redirect(
      `/dashboard/usuarios?error=${encodeURIComponent(error.message)}`,
    );
  }
  revalidatePath('/dashboard/usuarios');
  redirect('/dashboard/usuarios?password_changed=1');
}

export async function deleteUser(formData: FormData) {
  const me = await requireAdmin();
  const userId = String(formData.get('userId') ?? '');

  if (!userId) {
    redirect(
      `/dashboard/usuarios?error=${encodeURIComponent('userId ausente')}`,
    );
  }
  if (userId === me.id) {
    redirect(
      `/dashboard/usuarios?error=${encodeURIComponent('Você não pode deletar a si mesmo')}`,
    );
  }

  const admin = createAdminClient();
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) {
    redirect(
      `/dashboard/usuarios?error=${encodeURIComponent(error.message)}`,
    );
  }
  revalidatePath('/dashboard/usuarios');
  redirect('/dashboard/usuarios?deleted=1');
}
