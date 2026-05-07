import { LoginForm } from './login-form';

export const metadata = { title: 'Entrar — Pavcon Licitações' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; sent?: string; error?: string }>;
}) {
  const params = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold text-zinc-900">Pavcon Licitações</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Entre com seu email institucional. Você vai receber um link de acesso.
        </p>

        {params.sent && (
          <div className="mt-4 rounded-md bg-emerald-50 p-3 text-sm text-emerald-800">
            Link enviado. Confira sua caixa de entrada.
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
