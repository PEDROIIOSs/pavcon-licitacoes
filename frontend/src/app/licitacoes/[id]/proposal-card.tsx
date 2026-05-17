'use client';

import { useMemo, useState, useTransition } from 'react';
import { formatBRL } from '@/lib/utils';
import { cadastrarProposta } from './actions';

interface Props {
  licitacaoId: string;
  status: string;
  bdiEdital: number;
  totalEdital: number;
  /** Resultado prévio salvo no banco (se já cadastrou proposta antes) */
  proposta: {
    desconto_percentual: number | null;
    valor_proposta_pavcon: number | null;
    orcafascio_proposta_budget_id: string | null;
  };
}

interface SuccessPayload {
  budget_id?: string;
  budget_url?: string;
  bdi_proposta?: number;
  bdi_edital?: number;
  valor_edital?: number;
  valor_proposta?: number;
  economia?: number;
  warnings?: string[];
}

// Card de Proposta Readequada — aparece após o orçamento base ser cadastrado
// (status='fase1_concluida'). Permite aplicar desconto linear ajustando o BDI.
export function ProposalCard({
  licitacaoId,
  status,
  bdiEdital,
  totalEdital,
  proposta,
}: Props) {
  // Pré-popula com o desconto já salvo (re-rodar é idempotente — recria o
  // orçamento da proposta com o novo desconto)
  const [descontoStr, setDescontoStr] = useState<string>(
    proposta.desconto_percentual != null
      ? proposta.desconto_percentual.toString()
      : '10',
  );
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SuccessPayload | null>(null);

  const desconto = Number(descontoStr.replace(',', '.'));
  const descontoValido = Number.isFinite(desconto) && desconto > 0 && desconto < 100;

  // Preview matemático (sem chamar API). Mostra ao usuário ANTES de cadastrar
  // o que vai acontecer com o BDI e o valor total.
  const preview = useMemo(() => {
    if (!descontoValido) return null;
    const bdiPropostaPct = (1 + bdiEdital / 100) * (1 - desconto / 100) * 100 - 100;
    const valorProposta = totalEdital * (1 - desconto / 100);
    const economia = totalEdital - valorProposta;
    return { bdiPropostaPct, valorProposta, economia };
  }, [bdiEdital, totalEdital, desconto, descontoValido]);

  const bdiNegativo = preview != null && preview.bdiPropostaPct < 0;

  function handleSubmit() {
    if (!descontoValido || bdiNegativo) return;
    setError(null);
    setResult(null);
    startTransition(async () => {
      const r = await cadastrarProposta(licitacaoId, desconto);
      if (r?.error) {
        setError(r.error);
      } else {
        setResult({
          budget_id: r.budget_id,
          budget_url: r.budget_url,
          bdi_proposta: r.bdi_proposta,
          bdi_edital: r.bdi_edital,
          valor_edital: r.valor_edital,
          valor_proposta: r.valor_proposta,
          economia: r.economia,
          warnings: r.warnings,
        });
      }
    });
  }

  // Só faz sentido depois do orçamento base estar pronto
  if (status !== 'fase1_concluida' && status !== 'finalizado') {
    return null;
  }

  const propostaJaCadastrada = proposta.orcafascio_proposta_budget_id != null;
  const propostaUrl = proposta.orcafascio_proposta_budget_id
    ? `https://app.orcafascio.com/orc/orcamentos/${proposta.orcafascio_proposta_budget_id}`
    : null;

  return (
    <section className="space-y-4 rounded-lg border border-amber-200 bg-amber-50 p-6">
      <div>
        <h2 className="text-sm font-semibold text-amber-900">
          📊 Proposta Readequada — Desconto linear
        </h2>
        <p className="mt-1 text-xs text-amber-800">
          Cria uma <strong>2ª versão</strong> do orçamento no Orçafascio com BDI
          reduzido proporcionalmente. Matematicamente equivalente a aplicar o
          desconto em cada preço unitário com BDI:{' '}
          <code className="font-mono">
            BDI_proposta = (1+BDI)×(1−desconto%) − 1
          </code>
        </p>
      </div>

      {propostaJaCadastrada && (
        <div className="rounded-md bg-white p-3 text-xs text-amber-900">
          <p className="font-medium">
            ✓ Proposta já cadastrada (desconto {proposta.desconto_percentual}%)
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>
              Valor:{' '}
              <strong>
                {formatBRL(Number(proposta.valor_proposta_pavcon ?? 0))}
              </strong>
            </span>
            {propostaUrl && (
              <a
                href={propostaUrl}
                target="_blank"
                rel="noreferrer"
                className="text-amber-700 underline hover:text-amber-900"
              >
                Abrir no Orçafascio →
              </a>
            )}
          </div>
          <p className="mt-2 text-[11px] text-amber-700">
            Pra alterar o desconto, ajuste o valor abaixo e clique de novo —
            cria um novo orçamento (o anterior fica no Orçafascio pra você
            apagar manualmente se quiser).
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-md border border-amber-200 bg-white p-3">
          <p className="text-[11px] uppercase tracking-wide text-zinc-500">
            Total do edital
          </p>
          <p className="mt-1 text-lg font-semibold text-zinc-900">
            {formatBRL(totalEdital)}
          </p>
          <p className="text-[11px] text-zinc-500">BDI edital: {bdiEdital.toFixed(2)}%</p>
        </div>

        <div className="rounded-md border border-amber-200 bg-white p-3">
          <p className="text-[11px] uppercase tracking-wide text-zinc-500">
            Desconto linear
          </p>
          <div className="mt-1 flex items-baseline gap-1">
            <input
              type="number"
              min="0.01"
              max="99.99"
              step="0.01"
              value={descontoStr}
              onChange={(e) => setDescontoStr(e.target.value)}
              disabled={isPending}
              className="w-20 rounded border border-zinc-300 px-2 py-1 text-lg font-semibold focus:border-amber-500 focus:outline-none disabled:opacity-50"
            />
            <span className="text-lg font-semibold text-zinc-900">%</span>
          </div>
          {preview && (
            <p
              className={`text-[11px] ${
                bdiNegativo ? 'text-red-600' : 'text-zinc-500'
              }`}
            >
              BDI proposta: {preview.bdiPropostaPct.toFixed(2)}%
              {bdiNegativo && ' (inviável)'}
            </p>
          )}
        </div>

        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3">
          <p className="text-[11px] uppercase tracking-wide text-emerald-700">
            Valor da proposta
          </p>
          <p className="mt-1 text-lg font-semibold text-emerald-900">
            {preview ? formatBRL(preview.valorProposta) : '—'}
          </p>
          {preview && (
            <p className="text-[11px] text-emerald-700">
              Economia: {formatBRL(preview.economia)}
            </p>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-800">{error}</div>
      )}

      <button
        onClick={handleSubmit}
        disabled={isPending || !descontoValido || bdiNegativo}
        className="rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
      >
        {isPending
          ? 'Cadastrando proposta no Orçafascio…'
          : propostaJaCadastrada
            ? '🔁 Recadastrar proposta com novo desconto'
            : '📊 Cadastrar proposta no Orçafascio'}
      </button>

      {result && (
        <div className="space-y-2 rounded-md border border-emerald-300 bg-white p-4 text-sm">
          <p className="font-semibold text-emerald-900">
            ✅ Proposta cadastrada no Orçafascio!
          </p>
          {result.budget_url && (
            <a
              href={result.budget_url}
              target="_blank"
              rel="noreferrer"
              className="block rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-800 underline hover:bg-emerald-100"
            >
              {result.budget_url}
            </a>
          )}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-zinc-700">
            <dt>BDI edital:</dt>
            <dd className="font-medium">{result.bdi_edital?.toFixed(2)}%</dd>
            <dt>BDI proposta:</dt>
            <dd className="font-medium">{result.bdi_proposta?.toFixed(2)}%</dd>
            <dt>Valor edital:</dt>
            <dd className="font-medium">{formatBRL(result.valor_edital ?? 0)}</dd>
            <dt>Valor proposta:</dt>
            <dd className="font-medium text-emerald-700">
              {formatBRL(result.valor_proposta ?? 0)}
            </dd>
            <dt>Economia:</dt>
            <dd className="font-medium">{formatBRL(result.economia ?? 0)}</dd>
            <dt>Budget ID:</dt>
            <dd className="font-mono text-[11px]">{result.budget_id}</dd>
          </dl>
          {result.warnings && result.warnings.length > 0 && (
            <details className="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-900">
              <summary className="cursor-pointer">
                ⚠ {result.warnings.length} aviso(s) — ajuste manual recomendado
              </summary>
              <ul className="mt-2 list-disc pl-4">
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
