import { LoginForm } from './login-form';

export const metadata = { title: 'Entrar — OrçaPav AI' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    next?: string;
    reset_sent?: string;
    reset_ok?: string;
    error?: string;
  }>;
}) {
  const params = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold text-zinc-900">OrçaPav AI</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Entre com seu email e senha.
        </p>

        {params.reset_sent && (
          <div className="mt-4 rounded-md bg-emerald-50 p-3 text-sm text-emerald-800">
            Se o email existir, você vai receber um link pra redefinir a senha.
          </div>
        )}
        {params.reset_ok && (
          <div className="mt-4 rounded-md bg-emerald-50 p-3 text-sm text-emerald-800">
            Senha redefinida. Entre com a nova senha.
          </div>
        )}
        {params.error && (
          <div className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-800">
            {decodeURIComponent(params.error)}
          </div>
        )}

        <LoginForm next={params.next ?? '/dashboard'} />
      </div>
    </main>
  );
}
