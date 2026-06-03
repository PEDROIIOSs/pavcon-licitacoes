import Link from 'next/link';
import { requireAdmin } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { formatDate } from '@/lib/utils';
import { MappingsTable } from './mappings-table';

export const metadata = { title: 'Códigos descontinuados — OrçaPav AI' };
export const dynamic = 'force-dynamic';

export default async function CodeMappingsPage() {
  const me = await requireAdmin();
  const admin = createAdminClient();
  const { data: mappings } = await admin
    .from('orcafascio_code_mappings')
    .select('id, fonte_original, codigo_original, fonte_substituto, codigo_substituto, descricao, motivo, criado_em, atualizado_em')
    .order('atualizado_em', { ascending: false });

  const pendentes = (mappings ?? []).filter((m) => !m.codigo_substituto);
  const mapeados = (mappings ?? []).filter((m) => m.codigo_substituto);

  return (
    <div className="min-h-screen">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div>
            <Link href="/dashboard" className="text-xs text-zinc-500 hover:text-zinc-900">
              ← Painel
            </Link>
            <h1 className="text-lg font-semibold text-zinc-900">Códigos descontinuados</h1>
          </div>
          <div className="text-xs text-zinc-500">{me.email}</div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-6 py-8">
        <section className="rounded-md bg-blue-50 p-4 text-sm text-blue-900">
          <p className="font-medium">Como funciona</p>
          <p className="mt-1 text-xs">
            Quando o cadastro de uma composição falha porque o Orçafascio não
            reconhece o código (ex: SICRO 2 antigo), o sistema registra
            automaticamente nesta tabela. Você preenche o código atual
            equivalente e <strong>próximos editais usam a substituição
            automaticamente</strong> — sem precisar pedir ajuda.
          </p>
        </section>

        {pendentes.length > 0 && (
          <section className="space-y-3">
            <div>
              <h2 className="text-sm font-semibold text-amber-900">
                ⚠ {pendentes.length} código(s) pendente(s) de mapeamento
              </h2>
              <p className="mt-0.5 text-xs text-zinc-500">
                Encontre o código atual equivalente no Orçafascio e salve. Próximos editais que tiverem o mesmo código original vão usar a substituição automaticamente.
              </p>
            </div>
            <MappingsTable mappings={pendentes} highlight />
          </section>
        )}

        {mapeados.length > 0 && (
          <section className="space-y-3">
            <div>
              <h2 className="text-sm font-semibold text-emerald-900">
                ✓ {mapeados.length} código(s) mapeado(s)
              </h2>
              <p className="mt-0.5 text-xs text-zinc-500">
                Substituições ativas — aplicadas automaticamente em todos os editais.
              </p>
            </div>
            <MappingsTable mappings={mapeados} />
          </section>
        )}

        {(mappings ?? []).length === 0 && (
          <section className="rounded-md border border-zinc-200 bg-white p-6 text-center">
            <p className="text-sm text-zinc-500">
              Nenhum código descontinuado registrado ainda. Quando o sistema encontrar codes que o Orçafascio não aceita, eles vão aparecer aqui automaticamente.
            </p>
          </section>
        )}

        <p className="text-[11px] text-zinc-400">
          Última atualização: {mappings && mappings[0] ? formatDate(mappings[0].atualizado_em) : '—'}
        </p>
      </main>
    </div>
  );
}
