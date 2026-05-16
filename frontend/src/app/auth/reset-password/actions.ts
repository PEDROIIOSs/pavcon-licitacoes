'use server';

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';

export async function setNewPassword(formData: FormData) {
  const password = String(formData.get('password') ?? '');
  const confirm = String(formData.get('confirm') ?? '');

  if (password.length < 8) {
    redirect(
      `/auth/reset-password?error=${encodeURIComponent('Senha precisa ter pelo menos 8 caracteres')}`,
    );
  }
  if (password !== confirm) {
    redirect(
      `/auth/reset-password?error=${encodeURIComponent('As senhas não coincidem')}`,
    );
  }

  const supabase = await createClient();
  // updateUser exige sessão — vem da /auth/callback que trocou o code do email.
  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    redirect(
      `/auth/reset-password?error=${encodeURIComponent(error.message)}`,
    );
  }

  // Desloga o usuário pra forçar novo login com a senha nova (boa prática).
  await supabase.auth.signOut();
  redirect('/login?reset_ok=1');
}
