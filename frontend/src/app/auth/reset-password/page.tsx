import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { ResetForm } from './reset-form';

export const metadata = { title: 'Definir nova senha — OrçaPav AI' };

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  // Só acessível com sessão (vinda do link do email via /auth/callback).
  // Sem sessão, manda pro login.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect('/login?error=Link%20expirado%20ou%20inv%C3%A1lido');
  }

  const params = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold text-zinc-900">
          Definir nova senha
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          Mínimo 8 caracteres. Depois de salvar, você vai entrar de novo.
        </p>

        {params.error && (
          <div className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-800">
            {decodeURIComponent(params.error)}
          </div>
        )}

        <ResetForm />
      </div>
    </main>
  );
}
