import { redirect } from 'next/navigation';
import { createClient } from './supabase/server';

// ADMIN_EMAILS é OPCIONAL: lista de emails (separados por vírgula) que podem
// acessar áreas de admin. Não usa o helper env.* porque é opcional — sem ela,
// ninguém é admin (default seguro).
function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return adminEmails().includes(email.toLowerCase());
}

// Guarda de rota — chama no início de Server Components/Actions admin.
// Se não logado, manda pro login. Se logado mas não admin, manda pro dashboard.
export async function requireAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect('/login?next=/dashboard/usuarios');
  }
  if (!isAdmin(user.email)) {
    redirect(
      `/dashboard?error=${encodeURIComponent('Acesso restrito a administradores')}`,
    );
  }
  return user;
}
