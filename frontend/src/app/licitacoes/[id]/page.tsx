import { createClient } from '@/lib/supabase/server';
import { formatBRL, formatDate, statusColor, statusLabel } from '@/lib/utils';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ExtractionPanel } from './extraction-panel';
import { PollRefresher } from './poll-refresher';
import type { ExtractedItem } from './actions';

export const metadata = { title: 'Orçamento — Pavcon' };
export const dynamic = 'force-dynamic'; // sempre fresh, refletir estados em transição
// Server actions desta página (importar JSON manual, cadastrar Orçafascio) fazem
// múltiplos round-trips ao Supabase. Sem isso, action pesada estoura os 10s
// default do Vercel Hobby e o spinner fica eterno no cliente.
export const maxDuration = 60;

export default async function LicitacaoDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [licResp, arqResp, extrResp] = await Promise.all([
    supabase.from('licitacoes').select('*').eq('id', id).maybeSingle(),
    supabase
      .from('licitacao_arquivos')
      .select('id, filename_original, size_bytes, mime_type, created_at, total_paginas, storage_path')
      .eq('licitacao_id', id)
      .order('created_at', { ascending: false }),
    supabase
      .from('extracoes_ocr')
      .select('id, status, created_at, concluido_em, llm_model, prompt_versao, tokens_input, tokens_output, custo_usd, duracao_ms, json_extraido, json_corrigido, erro_detalhe, revisado_por, revisado_em')
      .eq('licitacao_id', id)
      .order('created_at', { ascending: false }),
  ]);

  if (licResp.error) {
    return (
      <main className="mx-auto max-w-4xl px-6 py-12">
        <p className="text-sm text-red-700">Erro: {licResp.error.message}</p>
      </main>
    );
  }
  if (!licResp.data) notFound();

  const licitacao = licResp.data;
  const arquivos = arqResp.data ?? [];
  const extracoes = extrResp.data ?? [];
  const ultimaExtracao = extracoes[0];

  // Soma do orçamento extraído: sem BDI, com BDI, e o BDI em si.
  // Só conta linhas tipo 'servico' pra não duplicar com grupos agregadores.
  const { data: linhasFinanceiras } = await supabase
    .from('composicoes_extraidas')
    .select('preco_total, preco_unitario_sem_bdi, quantidade')
    .eq('licitacao_id', id)
    .eq('tipo_linha', 'servico');

  let totalComBdi = 0;
  let totalSemBdi = 0;
  for (const l of linhasFinanceiras ?? []) {
    if (l.preco_total != null) totalComBdi += Number(l.preco_total);
    if (l.preco_unitario_sem_bdi != null && l.quantidade != null) {
      totalSemBdi += Number(l.preco_unitario_sem_bdi) * Number(l.quantidade);
    }
  }
  const totalBdi = totalComBdi - totalSemBdi;
  const temTotal = (linhasFinanceiras?.length ?? 0) > 0 && totalComBdi > 0;

  // Signed URLs dos PDFs pra extração manual (NotebookLM/Claude).
  // TTL de 1h é suficiente pra usuário baixar e arrastar pra ferramenta externa.
  const arquivosComUrl = await Promise.all(
    arquivos.map(async (a) => {
      const { data } = await supabase.storage
        .from('editais')
        .createSignedUrl(a.storage_path, 3600, {
          download: a.filename_original,
        });
      return {
        id: a.id,
        filename_original: a.filename_original,
        downloadUrl: data?.signedUrl ?? null,
      };
    }),
  );

  // Polling automático enquanto status indica trabalho em andamento
  const inFlightStatuses = new Set(['extraindo', 'criando_composicoes_edital', 'criando_orcamento_base']);
  const shouldPoll = inFlightStatuses.has(licitacao.status);

  return (
    <div className="min-h-screen">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div>
            <Link href="/dashboard" className="text-xs text-zinc-500 hover:text-zinc-900">
              ← Painel
            </Link>
            <h1 className="mt-1 text-xl font-semibold text-zinc-900">
              {licitacao.titulo}
            </h1>
            {licitacao.numero_edital && (
              <p className="text-xs text-zinc-500">
                {licitacao.numero_edital} · {licitacao.orgao_licitante ?? '—'}
              </p>
            )}
          </div>
          <span
            className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${statusColor(licitacao.status)}`}
          >
            {statusLabel(licitacao.status)}
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        {shouldPoll && <PollRefresher />}

        <section className="rounded-lg border border-zinc-200 bg-white p-6">
          <h2 className="text-sm font-semibold text-zinc-900">Arquivos</h2>
          {arquivos.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-500">Nenhum arquivo anexado.</p>
          ) : (
            <ul className="mt-2 divide-y divide-zinc-100">
              {arquivos.map((a) => (
                <li key={a.id} className="flex items-center justify-between py-2">
                  <div>
                    <p className="text-sm font-medium text-zinc-800">{a.filename_original}</p>
                    <p className="text-xs text-zinc-500">
                      {(a.size_bytes / 1024 / 1024).toFixed(2)} MB
                      {a.total_paginas ? ` · ${a.total_paginas} páginas` : ''}
                      {' · '}
                      {formatDate(a.created_at)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {temTotal && (
          <section className="rounded-lg border border-zinc-200 bg-white p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-zinc-900">
                  Total do orçamento (extraído)
                </h2>
                <p className="mt-0.5 text-xs text-zinc-500">
                  Soma dos itens (tipo serviço). Use pra validar contra a planilha do edital.
                </p>
              </div>
              <div className="text-right">
                <div className="text-2xl font-semibold text-zinc-900">
                  {formatBRL(totalComBdi)}
                </div>
                <div className="text-xs text-zinc-500">Total geral (com BDI)</div>
              </div>
            </div>
            <dl className="mt-4 grid grid-cols-3 gap-4 border-t border-zinc-100 pt-4 text-sm">
              <div>
                <dt className="text-xs text-zinc-500">Total sem BDI</dt>
                <dd className="mt-0.5 font-medium text-zinc-900">
                  {formatBRL(totalSemBdi)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500">
                  BDI{' '}
                  {totalSemBdi > 0 && (
                    <span className="text-zinc-400">
                      ({((totalBdi / totalSemBdi) * 100).toFixed(2)}%)
                    </span>
                  )}
                </dt>
                <dd className="mt-0.5 font-medium text-zinc-900">
                  {formatBRL(totalBdi)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500">Linhas (servicos)</dt>
                <dd className="mt-0.5 font-medium text-zinc-900">
                  {linhasFinanceiras?.length ?? 0}
                </dd>
              </div>
            </dl>
            {licitacao.valor_total_edital != null &&
              Math.abs(totalComBdi - Number(licitacao.valor_total_edital)) > 0.01 && (
                <p className="mt-3 rounded bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  ⚠ Total extraído ({formatBRL(totalComBdi)}) difere do valor de referência do
                  edital ({formatBRL(Number(licitacao.valor_total_edital))}) em{' '}
                  {formatBRL(totalComBdi - Number(licitacao.valor_total_edital))}.
                </p>
              )}
          </section>
        )}

        <ExtractionPanel
          licitacaoId={licitacao.id}
          status={licitacao.status}
          arquivoId={arquivos[0]?.id ?? null}
          arquivos={arquivosComUrl}
          ultimaExtracao={ultimaExtracao
            ? {
                id: ultimaExtracao.id,
                status: ultimaExtracao.status,
                created_at: ultimaExtracao.created_at,
                concluido_em: ultimaExtracao.concluido_em,
                llm_model: ultimaExtracao.llm_model,
                prompt_versao: ultimaExtracao.prompt_versao,
                tokens_input: ultimaExtracao.tokens_input,
                tokens_output: ultimaExtracao.tokens_output,
                custo_usd: ultimaExtracao.custo_usd,
                duracao_ms: ultimaExtracao.duracao_ms,
                erro_detalhe: ultimaExtracao.erro_detalhe,
                json:
                  (ultimaExtracao.json_corrigido as
                    | { cabecalho: Record<string, unknown>; itens: ExtractedItem[] }
                    | null) ??
                  (ultimaExtracao.json_extraido as
                    | { cabecalho: Record<string, unknown>; itens: ExtractedItem[] }
                    | null),
                ja_revisada: !!ultimaExtracao.json_corrigido,
              }
            : null}
        />

        {licitacao.status === 'erro' && ultimaExtracao?.erro_detalhe && (
          <section className="rounded-lg border border-red-200 bg-red-50 p-6">
            <h2 className="text-sm font-semibold text-red-900">Erro na extração</h2>
            <p className="mt-2 text-sm text-red-800">{ultimaExtracao.erro_detalhe}</p>
            <p className="mt-2 text-xs text-red-700">
              Use o botão <strong>&ldquo;Voltar pra rascunho&rdquo;</strong> e tente novamente.
            </p>
          </section>
        )}

        <section className="rounded-lg border border-zinc-200 bg-white p-6 text-xs text-zinc-500">
          <h2 className="mb-2 text-sm font-semibold text-zinc-900">Custos da extração</h2>
          {ultimaExtracao?.custo_usd != null ? (
            <p>
              <strong className="text-zinc-700">{formatBRL((ultimaExtracao.custo_usd ?? 0) * 5.5)}</strong>
              {' '}aprox. (USD {ultimaExtracao.custo_usd?.toFixed(4)} ·
              {' '}{ultimaExtracao.tokens_input ?? '?'} tokens in /
              {' '}{ultimaExtracao.tokens_output ?? '?'} out · {ultimaExtracao.llm_model})
            </p>
          ) : (
            <p>Nenhuma extração concluída ainda.</p>
          )}
        </section>
      </main>
    </div>
  );
}

