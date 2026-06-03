'use client';

import { useState, useTransition } from 'react';
import { formatBRL } from '@/lib/utils';
import { cadastrarPropostaOrcafascio, calcularProposta, exportPropostaCSV } from './actions';

interface Props {
  licitacaoId: string;
  status: string;
  bdiEdital: number;
  totalEdital: number;
  orcamentoBaseId: string | null;
  proposta: {
    desconto_percentual: number | null;
    valor_proposta_pavcon: number | null;
    orcafascio_proposta_budget_id: string | null;
  };
}

interface CalcResult {
  bdi_edital: number;
  desconto_solicitado_pct: number;
  total_edital_com_bdi: number;
  total_proposta_com_bdi: number;
  economia: number;
  desconto_efetivo_global_pct: number;
  custo_mo_preservado: number;
  custo_outros_descontavel: number;
  itens: Array<{
    item_codigo: string;
    descricao: string;
    fonte: string | null;
    codigo: string | null;
    quantidade: number;
    unidade: string | null;
    pu_edital_com_bdi: number;
    total_edital: number;
    pct_mo: number;
    pu_proposta_com_bdi: number;
    total_proposta: number;
    desconto_efetivo_item_pct: number;
    metodo_mo: 'exato_propria' | 'estimado_banco' | 'sem_mo';
    obs: string;
  }>;
  alertas: string[];
}

export function ProposalCard({
  licitacaoId,
  status,
  bdiEdital,
  totalEdital,
  orcamentoBaseId,
  proposta,
}: Props) {
  const [descontoStr, setDescontoStr] = useState<string>(
    proposta.desconto_percentual != null
      ? proposta.desconto_percentual.toString()
      : '10',
  );
  // Modo de cálculo: 'desconto' usa % sobre custos NÃO-MO (regra padrão).
  // 'valor_alvo' permite o orçamentista digitar diretamente o valor final
  // que quer pra proposta — útil quando o cálculo MO-aware do PavCon não
  // bate com o esperado (ex: orçamento base com valor abaixo do real, codes
  // descontinuados, etc.) e ele quer forçar um número específico.
  const [modo, setModo] = useState<'desconto' | 'valor_alvo'>('desconto');
  const [valorAlvoStr, setValorAlvoStr] = useState<string>('');
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CalcResult | null>(null);
  const [showTable, setShowTable] = useState(false);
  const [cadastroResult, setCadastroResult] = useState<{
    budget_id?: string;
    budget_url?: string;
    valor_aplicado?: number;
    warnings?: string[];
  } | null>(null);

  const desconto = Number(descontoStr.replace(',', '.'));
  const descontoValido = Number.isFinite(desconto) && desconto > 0 && desconto < 100;
  const valorAlvo = Number(valorAlvoStr.replace(/[^\d,\.]/g, '').replace(',', '.'));
  const valorAlvoValido = Number.isFinite(valorAlvo) && valorAlvo > 0;

  function handleCalc() {
    if (!descontoValido) return;
    setError(null);
    startTransition(async () => {
      const r = await calcularProposta(licitacaoId, desconto);
      if (r.error) {
        setError(r.error);
        setResult(null);
      } else {
        setResult(r as CalcResult);
        setShowTable(true);
      }
    });
  }

  function handleCadastrarOrcafascio() {
    if (modo === 'desconto' && !descontoValido) return;
    if (modo === 'valor_alvo' && !valorAlvoValido) return;
    if (!orcamentoBaseId) {
      setError(
        'Orçamento base não encontrado no Orçafascio. Cadastre o orçamento base primeiro ou re-rode o Passo 2.',
      );
      return;
    }
    const alvo = modo === 'valor_alvo' ? valorAlvo : result?.total_proposta_com_bdi;
    if (
      !confirm(
        `Cadastrar proposta no Orçafascio?\n\nIsso vai:\n• COPIAR o orçamento base no Orçafascio\n• Aplicar "ajustar valor" pra bater R$ ${alvo?.toFixed(2) ?? '???'}\n\n${modo === 'valor_alvo' ? 'MODO "Valor alvo direto": você digitou o valor explicitamente — vamos forçar exatamente esse total. Cálculo MO-aware ignorado.\n\n' : ''}OBSERVAÇÃO: o Orçafascio aplica o ajuste de forma LINEAR (proporcional em todos itens, inclusive MO). O total final bate com o valor escolhido, mas a divisão interna por item segue o ajuste linear. Pra auditoria detalhada, use o CSV baixado.\n\nContinuar?`,
      )
    ) {
      return;
    }
    setError(null);
    setCadastroResult(null);
    startTransition(async () => {
      const r = await cadastrarPropostaOrcafascio(
        licitacaoId,
        descontoValido ? desconto : 1, // desconto é obrigatório no backend mesmo quando temos valor alvo
        modo === 'valor_alvo' ? valorAlvo : undefined,
      );
      if (r.error) {
        setError(r.error);
      } else {
        setCadastroResult({
          budget_id: r.budget_id,
          budget_url: r.budget_url,
          valor_aplicado: r.valor_aplicado,
          warnings: r.warnings,
        });
      }
    });
  }

  function handleExportCsv() {
    if (!descontoValido) return;
    setError(null);
    startTransition(async () => {
      const r = await exportPropostaCSV(licitacaoId, desconto);
      if (r.error) {
        setError(r.error);
        return;
      }
      if (!r.csv || !r.filename) {
        setError('CSV vazio.');
        return;
      }
      const blob = new Blob([r.csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = r.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
  }

  if (status !== 'fase1_concluida' && status !== 'finalizado') return null;

  return (
    <section className="space-y-4 rounded-lg border border-amber-200 bg-amber-50 p-6">
      <div>
        <h2 className="text-sm font-semibold text-amber-900">
          📊 Proposta Readequada — Desconto linear (regras de licitação)
        </h2>
        <p className="mt-1 text-xs text-amber-800">
          <strong>Regras aplicadas:</strong> (1) BDI da proposta = BDI do edital
          ({bdiEdital.toFixed(2)}%, sem alteração). (2) Desconto <strong>não incide
          sobre mão de obra</strong> — só sobre materiais, equipamentos e outros
          custos. Pra composições <strong>PRÓPRIAS</strong>, o % de MO é calculado
          exato dos sub-itens; pra composições de base (SINAPI/SICRO/etc), usado
          % MO estimado por banco (próxima iteração: buscar decomposição real
          do Orçafascio).
        </p>
      </div>

      {/* Toggle de modo: desconto vs valor direto */}
      <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-white p-2">
        <span className="text-xs font-medium text-zinc-700">Modo:</span>
        <button
          onClick={() => setModo('desconto')}
          disabled={isPending}
          className={`rounded-md px-3 py-1 text-xs font-medium transition ${
            modo === 'desconto'
              ? 'bg-amber-600 text-white'
              : 'border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50'
          } disabled:opacity-50`}
        >
          % Desconto (regra MO)
        </button>
        <button
          onClick={() => setModo('valor_alvo')}
          disabled={isPending}
          className={`rounded-md px-3 py-1 text-xs font-medium transition ${
            modo === 'valor_alvo'
              ? 'bg-amber-600 text-white'
              : 'border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50'
          } disabled:opacity-50`}
        >
          R$ Valor alvo direto
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-md border border-amber-200 bg-white p-3">
          <p className="text-[11px] uppercase tracking-wide text-zinc-500">
            Total do edital
          </p>
          <p className="mt-1 text-lg font-semibold text-zinc-900">
            {formatBRL(totalEdital)}
          </p>
          <p className="text-[11px] text-zinc-500">BDI: {bdiEdital.toFixed(2)}%</p>
        </div>

        {modo === 'desconto' ? (
          <div className="rounded-md border border-amber-200 bg-white p-3">
            <p className="text-[11px] uppercase tracking-wide text-zinc-500">
              Desconto pretendido
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
                className="w-20 rounded border border-zinc-300 px-2 py-1 text-lg font-semibold text-zinc-900 focus:border-amber-500 focus:outline-none disabled:opacity-50"
              />
              <span className="text-lg font-semibold text-zinc-900">%</span>
            </div>
            <p className="text-[11px] text-zinc-500">
              Só incide sobre custos NÃO-MO
            </p>
          </div>
        ) : (
          <div className="rounded-md border border-amber-200 bg-amber-100 p-3">
            <p className="text-[11px] uppercase tracking-wide text-amber-900">
              Valor alvo da proposta
            </p>
            <div className="mt-1 flex items-baseline gap-1">
              <span className="text-lg font-semibold text-amber-900">R$</span>
              <input
                type="text"
                inputMode="decimal"
                placeholder="0,00"
                value={valorAlvoStr}
                onChange={(e) => setValorAlvoStr(e.target.value)}
                disabled={isPending}
                className="w-32 rounded border border-amber-400 px-2 py-1 text-lg font-semibold text-amber-900 focus:border-amber-600 focus:outline-none disabled:opacity-50"
              />
            </div>
            <p className="text-[11px] text-amber-900">
              Ignora MO — força total exato
            </p>
          </div>
        )}

        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3">
          <p className="text-[11px] uppercase tracking-wide text-emerald-700">
            Total da proposta
          </p>
          <p className="mt-1 text-lg font-semibold text-emerald-900">
            {modo === 'valor_alvo' && valorAlvoValido
              ? formatBRL(valorAlvo)
              : result
                ? formatBRL(result.total_proposta_com_bdi)
                : '—'}
          </p>
          {modo === 'desconto' && result && (
            <p className="text-[11px] text-emerald-700">
              Economia: {formatBRL(result.economia)} ({result.desconto_efetivo_global_pct.toFixed(2)}% efetivo)
            </p>
          )}
          {modo === 'valor_alvo' && valorAlvoValido && (
            <p className="text-[11px] text-emerald-700">
              Economia vs edital: {formatBRL(totalEdital - valorAlvo)} ({((1 - valorAlvo / totalEdital) * 100).toFixed(2)}%)
            </p>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-800">{error}</div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {modo === 'desconto' && (
          <>
            <button
              onClick={handleCalc}
              disabled={isPending || !descontoValido}
              className="rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
            >
              {isPending ? 'Calculando…' : '🧮 Calcular proposta'}
            </button>
            <button
              onClick={handleExportCsv}
              disabled={isPending || !result}
              className="rounded-md border border-amber-300 bg-white px-3 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
              title="Baixa o detalhamento item a item em CSV (abre no Excel/Google Sheets)"
            >
              📥 Baixar CSV
            </button>
          </>
        )}
        <button
          onClick={handleCadastrarOrcafascio}
          disabled={
            isPending ||
            !orcamentoBaseId ||
            (modo === 'desconto' && !result) ||
            (modo === 'valor_alvo' && !valorAlvoValido)
          }
          className="rounded-md bg-purple-600 px-3 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50"
          title={
            !orcamentoBaseId
              ? 'Orçamento base não encontrado — recadastre o Passo 2 primeiro'
              : modo === 'valor_alvo'
                ? 'Cadastra proposta com valor exato digitado (ignora cálculo MO)'
                : 'Copia o orçamento base + aplica "ajustar valor" (linear)'
          }
        >
          🚀 Cadastrar no Orçafascio
        </button>
      </div>

      {cadastroResult && (
        <div className="space-y-2 rounded-md border border-purple-300 bg-purple-50 p-4 text-sm">
          <p className="font-semibold text-purple-900">
            ✅ Proposta cadastrada no Orçafascio!
          </p>
          {cadastroResult.budget_url && (
            <a
              href={cadastroResult.budget_url}
              target="_blank"
              rel="noreferrer"
              className="block rounded-md bg-white px-3 py-2 text-xs text-purple-800 underline hover:bg-purple-100"
            >
              {cadastroResult.budget_url}
            </a>
          )}
          {cadastroResult.valor_aplicado != null && (
            <p className="text-xs text-purple-800">
              Valor aplicado: <strong>{formatBRL(cadastroResult.valor_aplicado)}</strong>
            </p>
          )}
          <p className="rounded bg-amber-50 p-2 text-[11px] text-amber-900">
            ⚠ Atenção: o Orçafascio aplicou o ajuste de forma <strong>linear</strong> em
            todos os itens. O <strong>total bate</strong> com nosso cálculo MO-aware,
            mas a divisão interna por item segue o ajuste deles. Pra a auditoria
            detalhada da regra de MO, use o CSV baixado.
          </p>
          {cadastroResult.warnings && cadastroResult.warnings.length > 0 && (
            <details className="mt-1 rounded bg-amber-50 p-2 text-[11px] text-amber-900">
              <summary className="cursor-pointer">
                {cadastroResult.warnings.length} aviso(s)
              </summary>
              <ul className="mt-1 list-disc pl-4">
                {cadastroResult.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {result && (
        <div className="space-y-3 rounded-md border border-amber-200 bg-white p-4 text-sm">
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs md:grid-cols-4">
            <div>
              <div className="text-zinc-500">Custo MO preservado</div>
              <div className="font-medium text-zinc-900">
                {formatBRL(result.custo_mo_preservado)}
              </div>
            </div>
            <div>
              <div className="text-zinc-500">Custo descontável</div>
              <div className="font-medium text-zinc-900">
                {formatBRL(result.custo_outros_descontavel)}
              </div>
            </div>
            <div>
              <div className="text-zinc-500">Desconto solicitado</div>
              <div className="font-medium text-zinc-900">
                {result.desconto_solicitado_pct.toFixed(2)}%
              </div>
            </div>
            <div>
              <div className="text-zinc-500">Desconto efetivo (global)</div>
              <div className="font-medium text-emerald-700">
                {result.desconto_efetivo_global_pct.toFixed(2)}%
              </div>
            </div>
          </div>

          {result.alertas.length > 0 && (
            <details className="rounded bg-amber-50 p-2 text-xs text-amber-900">
              <summary className="cursor-pointer font-medium">
                ⚠ {result.alertas.length} alerta(s) sobre precisão
              </summary>
              <ul className="mt-2 list-disc pl-4">
                {result.alertas.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </details>
          )}

          <details open={showTable} onToggle={(e) => setShowTable((e.target as HTMLDetailsElement).open)}>
            <summary className="cursor-pointer text-xs font-medium text-zinc-700">
              📋 Detalhamento item a item ({result.itens.length} itens)
            </summary>
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full text-[11px]">
                <thead className="bg-zinc-50 text-left text-zinc-600">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">Item</th>
                    <th className="px-2 py-1.5 font-medium">Descrição</th>
                    <th className="px-2 py-1.5 font-medium">Fonte</th>
                    <th className="px-2 py-1.5 text-right font-medium">Qtd</th>
                    <th className="px-2 py-1.5 text-right font-medium">PU Edital</th>
                    <th className="px-2 py-1.5 text-right font-medium">Total Edital</th>
                    <th className="px-2 py-1.5 text-right font-medium">% MO</th>
                    <th className="px-2 py-1.5 text-right font-medium">PU Proposta</th>
                    <th className="px-2 py-1.5 text-right font-medium">Total Proposta</th>
                    <th className="px-2 py-1.5 text-right font-medium">Desc. ef.</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {result.itens.map((it) => (
                    <tr key={it.item_codigo}>
                      <td className="px-2 py-1 font-mono text-zinc-700">{it.item_codigo}</td>
                      <td className="px-2 py-1 max-w-xs truncate text-zinc-800" title={it.descricao}>
                        {it.descricao}
                      </td>
                      <td className="px-2 py-1">
                        <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${
                          it.metodo_mo === 'exato_propria'
                            ? 'bg-emerald-100 text-emerald-800'
                            : it.metodo_mo === 'estimado_banco'
                              ? 'bg-amber-100 text-amber-800'
                              : 'bg-zinc-100 text-zinc-700'
                        }`}>
                          {it.fonte ?? '—'}
                        </span>
                      </td>
                      <td className="px-2 py-1 text-right">{it.quantidade.toFixed(2)}</td>
                      <td className="px-2 py-1 text-right">{formatBRL(it.pu_edital_com_bdi)}</td>
                      <td className="px-2 py-1 text-right">{formatBRL(it.total_edital)}</td>
                      <td className="px-2 py-1 text-right text-zinc-600">{it.pct_mo.toFixed(1)}%</td>
                      <td className="px-2 py-1 text-right">{formatBRL(it.pu_proposta_com_bdi)}</td>
                      <td className="px-2 py-1 text-right font-medium text-emerald-700">{formatBRL(it.total_proposta)}</td>
                      <td className="px-2 py-1 text-right text-zinc-600">{it.desconto_efetivo_item_pct.toFixed(2)}%</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-zinc-50 font-medium">
                  <tr>
                    <td className="px-2 py-1.5" colSpan={5}>TOTAL</td>
                    <td className="px-2 py-1.5 text-right">{formatBRL(result.total_edital_com_bdi)}</td>
                    <td className="px-2 py-1.5"></td>
                    <td className="px-2 py-1.5"></td>
                    <td className="px-2 py-1.5 text-right text-emerald-700">{formatBRL(result.total_proposta_com_bdi)}</td>
                    <td className="px-2 py-1.5 text-right text-emerald-700">{result.desconto_efetivo_global_pct.toFixed(2)}%</td>
                  </tr>
                </tfoot>
              </table>
              <p className="mt-2 text-[10px] text-zinc-500">
                Legenda fonte: <span className="rounded bg-emerald-100 px-1 text-emerald-800">PROPRIA</span> = % MO exato; <span className="rounded bg-amber-100 px-1 text-amber-800">SINAPI/SICRO/etc</span> = % MO estimado por banco.
              </p>
            </div>
          </details>
        </div>
      )}
    </section>
  );
}
