import Link from 'next/link';
import { requireAdmin, isAdmin } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { formatDate } from '@/lib/utils';
import { CreateUserForm } from './create-form';
import { RowActions } from './row-actions';

export const metadata = { title: 'Usuários — Pavcon' };
export const dynamic = 'force-dynamic';

export default async function UsuariosPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    created?: string;
    deleted?: string;
    password_changed?: string;
  }>;
}) {
  const me = await requireAdmin();
  const params = await searchParams;

  const admin = createAdminClient();
  const { data, error: listError } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 200,
  });
  const users = data?.users ?? [];

  return (
    <div className="min-h-screen">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div>
            <Link
              href="/dashboard"
              className="text-xs text-zinc-500 hover:text-zinc-900"
            >
              ← Painel
            </Link>
            <h1 className="text-lg font-semibold text-zinc-900">Usuários</h1>
          </div>
          <div className="text-xs text-zinc-500">{me.email}</div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-8 px-6 py-8">
        {params.error && (
          <div className="rounded-md bg-red-50 p-3 text-sm text-red-800">
            {decodeURIComponent(params.error)}
          </div>
        )}
        {params.created && (
          <div className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-800">
            Usuário <strong>{decodeURIComponent(params.created)}</strong> criado
            com sucesso.
          </div>
        )}
        {params.deleted && (
          <div className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-800">
            Usuário removido.
          </div>
        )}
        {params.password_changed && (
          <div className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-800">
            Senha alterada com sucesso.
          </div>
        )}

        <section className="rounded-lg border border-zinc-200 bg-white p-6">
          <h2 className="text-base font-semibold text-zinc-900">
            Criar novo usuário
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            O usuário já entra confirmado e pode logar com a senha definida
            abaixo. Compartilhe a senha com ele e oriente a trocar pelo fluxo de
            &quot;Esqueci minha senha&quot;.
          </p>
          <div className="mt-4">
            <CreateUserForm />
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-base font-semibold text-zinc-900">
            Usuários cadastrados ({users.length})
          </h2>
          {listError && (
            <div className="rounded-md bg-red-50 p-3 text-sm text-red-800">
              Erro ao listar usuários: {listError.message}
            </div>
          )}
          <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
            <table className="min-w-full divide-y divide-zinc-200 text-sm">
              <thead className="bg-zinc-50">
                <tr>
                  <Th>Email</Th>
                  <Th>Papel</Th>
                  <Th>Criado em</Th>
                  <Th>Último login</Th>
                  <Th className="text-right">Ações</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200">
                {users.map((u) => {
                  const isMe = u.id === me.id;
                  const userIsAdmin = isAdmin(u.email);
                  return (
                    <tr key={u.id} className="hover:bg-zinc-50">
                      <td className="px-4 py-3 align-top">
                        <span className="font-medium text-zinc-900">
                          {u.email ?? '—'}
                        </span>
                        {isMe && (
                          <span className="ml-2 inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600">
                            você
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 align-top">
                        {userIsAdmin ? (
                          <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-800">
                            admin
                          </span>
                        ) : (
                          <span className="text-xs text-zinc-500">comum</span>
                        )}
                      </td>
                      <td className="px-4 py-3 align-top text-zinc-500">
                        {formatDate(u.created_at)}
                      </td>
                      <td className="px-4 py-3 align-top text-zinc-500">
                        {u.last_sign_in_at ? formatDate(u.last_sign_in_at) : '—'}
                      </td>
                      <td className="px-4 py-3 align-top">
                        <RowActions
                          userId={u.id}
                          email={u.email ?? ''}
                          isMe={isMe}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}

function Th({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={`px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 ${className}`}
    >
      {children}
    </th>
  );
}
