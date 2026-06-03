import Image from 'next/image';
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
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-br from-pavcon-navy-50 via-white to-pavcon-orange-50 px-4 py-10">
      <div className="w-full max-w-md">
        {/* Logo PavCon acima do card */}
        <div className="mb-6 flex justify-center">
          <Image
            src="/brand/pavcon-horizontal.jpg"
            alt="PavCon Construtora"
            width={224}
            height={58}
            priority
            className="h-14 w-auto"
          />
        </div>

        <div className="rounded-2xl border border-zinc-200 bg-white p-8 shadow-xl shadow-pavcon-navy/10">
          {/* Faixa de marca no topo do card */}
          <div className="-mt-8 mb-6 flex justify-center">
            <span className="inline-flex items-center gap-2 rounded-full bg-pavcon-navy px-4 py-1.5 text-[11px] font-semibold uppercase tracking-widest text-white shadow-md">
              <span className="h-1.5 w-1.5 rounded-full bg-pavcon-orange" />
              OrçaPav AI
            </span>
          </div>

          <h1 className="text-center text-2xl font-bold text-pavcon-coal">
            Bem-vindo
          </h1>
          <p className="mt-1 text-center text-sm text-zinc-500">
            Plataforma de automação de orçamentos da PavCon Construtora.
          </p>

          {params.reset_sent && (
            <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
              Se o email existir, você vai receber um link pra redefinir a senha.
            </div>
          )}
          {params.reset_ok && (
            <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
              Senha redefinida. Entre com a nova senha.
            </div>
          )}
          {params.error && (
            <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              {decodeURIComponent(params.error)}
            </div>
          )}

          <LoginForm next={params.next ?? '/dashboard'} />
        </div>

        <p className="mt-6 text-center text-[11px] text-zinc-500">
          © {new Date().getFullYear()} PavCon Construtora · Todos os direitos reservados
        </p>
      </div>
    </main>
  );
}
