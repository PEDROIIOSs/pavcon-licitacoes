import { createClient } from '@/lib/supabase/server';
import { signOut } from '../login/actions';
import { formatBRL, formatDate, statusColor, statusLabel } from '@/lib/utils';
import { isAdmin } from '@/lib/auth';
import Link from 'next/link';

export const metadata = { title: 'Painel — Pavcon Orçamentos' };

interface DashboardRow {
  id: string;
  titulo: string;
  numero_edital: string | null;
  orgao_licitante: string | null;
  municipio: string | null;
  uf: string | null;
  status: string;
  data_abertura: string | null;
  valor_total_edital: number | null;
  valor_proposta_pavcon: number | null;
  bdi_referencia_edital: number | null;
  bdi_pavcon: number | null;
  desconto_percentual: number | null;
  criado_por_nome: string | null;
  created_at: string;
  fase1_concluida_em: string | null;
  finalizada_em: string | null;
  qtd_arquivos: number;
  qtd_itens_extraidos: number;
  qtd_composicoes_proprias: number;
  aguarda_acao_humana: boolean;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const { data: licitacoes, error } = await supabase
    .from('vw_dashboard_licitacoes')
    .select('*')
    .order('created_at', { ascending: false })
    .returns<DashboardRow[]>();

  return (
    <div className="min-h-screen">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold text-zinc-900">Pavcon Orçamentos</h1>
            <p className="text-xs text-zinc-500">
              {user?.email ?? '—'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {isAdmin(user?.email) && (
              <Link
                href="/dashboard/usuarios"
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
              >
                Usuários
              </Link>
            )}
            <form action={signOut}>
              <button
                type="submit"
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
              >
                Sair
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        {params.error && (
          <div className="mb-6 rounded-md bg-red-50 p-3 text-sm text-red-800">
            {decodeURIComponent(params.error)}
          </div>
        )}
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-xl font-semibold text-zinc-900">Orçamentos</h2>
          <Link
            href="/licitacoes/nova"
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
          >
            Novo orçamento
          </Link>
        </div>

        {error && (
          <div className="rounded-md bg-red-50 p-4 text-sm text-red-800">
            Erro ao carregar licitações: {error.message}
          </div>
        )}

        {!error && (!licitacoes || licitacoes.length === 0) && (
          <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-12 text-center">
            <p className="text-sm text-zinc-500">
              Nenhum orçamento cadastrado ainda. Clique em <strong>Novo orçamento</strong> pra começar.
            </p>
          </div>
        )}

        {licitacoes && licitacoes.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
            <table className="min-w-full divide-y divide-zinc-200 text-sm">
              <thead className="bg-zinc-50">
                <tr>
                  <Th>Título / Edital</Th>
                  <Th>Órgão</Th>
                  <Th>Status</Th>
                  <Th>Valor referência</Th>
                  <Th>Itens</Th>
                  <Th>Criada em</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200">
                {licitacoes.map((l) => (
                  <tr key={l.id} className="hover:bg-zinc-50">
                    <td className="px-4 py-3 align-top">
                      <Link href={`/licitacoes/${l.id}`} className="font-medium text-zinc-900 hover:underline">
                        {l.titulo}
                      </Link>
                      {l.numero_edital && (
                        <div className="text-xs text-zinc-500">{l.numero_edital}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 align-top text-zinc-700">
                      {l.orgao_licitante ?? '—'}
                      {l.municipio && (
                        <div className="text-xs text-zinc-500">
                          {l.municipio}{l.uf ? `/${l.uf}` : ''}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 align-top">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusColor(l.status)}`}>
                        {statusLabel(l.status)}
                      </span>
                      {l.aguarda_acao_humana && (
                        <div className="mt-1 text-xs font-medium text-blue-700">
                          ⚠ aguarda você
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 align-top text-zinc-700">
                      {formatBRL(l.valor_total_edital)}
                    </td>
                    <td className="px-4 py-3 align-top text-zinc-700">
                      {l.qtd_itens_extraidos > 0 ? l.qtd_itens_extraidos : '—'}
                    </td>
                    <td className="px-4 py-3 align-top text-zinc-500">
                      {formatDate(l.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500">
      {children}
    </th>
  );
}
