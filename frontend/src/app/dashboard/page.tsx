import { createClient } from '@/lib/supabase/server';
import { signOut } from '../login/actions';
import { formatBRL, formatDate, statusColor, statusLabel } from '@/lib/utils';
import { isAdmin } from '@/lib/auth';
import { RowActions } from './row-actions';
import Link from 'next/link';
import Image from 'next/image';

export const metadata = { title: 'Painel — OrçaPav AI' };

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
  searchParams: Promise<{ error?: string; deleted?: string }>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const userIsAdmin = isAdmin(user?.email);

  const { data: licitacoes, error } = await supabase
    .from('vw_dashboard_licitacoes')
    .select('*')
    .order('created_at', { ascending: false })
    .returns<DashboardRow[]>();

  // Soma do preco_total das composições extraídas (só linhas tipo "servico",
  // pra não duplicar com grupos agregadores). Permite validar se o total
  // bate com o orçamento referência do edital.
  const ids = (licitacoes ?? []).map((l) => l.id);
  const { data: precos } = ids.length
    ? await supabase
        .from('composicoes_extraidas')
        .select('licitacao_id, preco_total')
        .in('licitacao_id', ids)
        .eq('tipo_linha', 'servico')
    : { data: [] };
  const totalExtraidoByLic = new Map<string, number>();
  (precos ?? []).forEach((row) => {
    if (row.preco_total != null) {
      totalExtraidoByLic.set(
        row.licitacao_id as string,
        (totalExtraidoByLic.get(row.licitacao_id as string) ?? 0) +
          Number(row.preco_total),
      );
    }
  });

  return (
    <div className="min-h-screen">
      <header className="border-b border-zinc-200 bg-white shadow-sm">
        {/* Faixa fina navy no topo — identidade da marca PavCon */}
        <div className="h-1 w-full bg-gradient-to-r from-pavcon-navy via-pavcon-navy-light to-pavcon-orange" />
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-4">
            <Link href="/dashboard" className="flex items-center gap-3">
              <Image
                src="/brand/pavcon-horizontal.jpg"
                alt="PavCon Construtora"
                width={140}
                height={36}
                priority
                className="h-9 w-auto"
              />
              <span className="hidden h-8 w-px bg-zinc-200 sm:block" />
              <div className="hidden sm:block">
                <p className="text-sm font-bold tracking-tight text-pavcon-coal">
                  OrçaPav <span className="text-pavcon-orange">AI</span>
                </p>
                <p className="text-[10px] text-zinc-500">Automação de orçamentos</p>
              </div>
            </Link>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden text-xs text-zinc-500 sm:inline">{user?.email ?? '—'}</span>
            {userIsAdmin && (
              <>
                <Link
                  href="/dashboard/code-mappings"
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:border-pavcon-navy hover:bg-pavcon-navy-50 hover:text-pavcon-navy"
                  title="Mapeamento de códigos descontinuados do Orçafascio"
                >
                  Códigos
                </Link>
                <Link
                  href="/dashboard/usuarios"
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:border-pavcon-navy hover:bg-pavcon-navy-50 hover:text-pavcon-navy"
                >
                  Usuários
                </Link>
              </>
            )}
            <form action={signOut}>
              <button
                type="submit"
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:border-pavcon-orange hover:bg-pavcon-orange-50 hover:text-pavcon-orange-dark"
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
        {params.deleted && (
          <div className="mb-6 rounded-md bg-emerald-50 p-3 text-sm text-emerald-800">
            Licitação removida.
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
                  <Th>Valor extraído</Th>
                  <Th>Itens</Th>
                  <Th>Criada em</Th>
                  {userIsAdmin && <Th className="text-right">Ações</Th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200">
                {licitacoes.map((l) => {
                  const valorExtraido = totalExtraidoByLic.get(l.id) ?? null;
                  const valorRef = l.valor_total_edital;
                  const diff =
                    valorExtraido != null && valorRef != null
                      ? valorExtraido - valorRef
                      : null;
                  return (
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
                        {valorExtraido != null ? (
                          <>
                            <div className="font-medium">{formatBRL(valorExtraido)}</div>
                            {valorRef != null && (
                              <div className="text-xs text-zinc-500">
                                ref: {formatBRL(valorRef)}
                                {diff != null && Math.abs(diff) > 0.01 && (
                                  <span
                                    className={`ml-1 ${diff > 0 ? 'text-amber-700' : 'text-red-700'}`}
                                  >
                                    ({diff > 0 ? '+' : ''}
                                    {formatBRL(diff)})
                                  </span>
                                )}
                              </div>
                            )}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-4 py-3 align-top text-zinc-700">
                        {l.qtd_itens_extraidos > 0 ? l.qtd_itens_extraidos : '—'}
                      </td>
                      <td className="px-4 py-3 align-top text-zinc-500">
                        {formatDate(l.created_at)}
                      </td>
                      {userIsAdmin && (
                        <td className="px-4 py-3 align-top text-right">
                          <RowActions licitacaoId={l.id} titulo={l.titulo} />
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
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
