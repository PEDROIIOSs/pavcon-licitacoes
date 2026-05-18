import { formatBRL, formatDate } from '@/lib/utils';

interface ServicoExtraido {
  item_codigo: string;
  descricao: string;
  fonte: string | null;
  codigo: string | null;
  unidade: string | null;
  quantidade: number | null;
  preco_unitario_com_bdi: number | null;
  preco_total: number | null;
  orcafascio_composition_id: string | null;
}

interface CadastroResumo {
  cadastrado_em?: string;
  budget_id?: string;
  budget_url?: string;
  composicoes_criadas?: number;
  total_itens_batch?: number;
  bdi?: number;
  leis_sociais_horista?: number;
  bancos_configurados?: string[];
  warnings?: string[];
}

interface Props {
  servicos: ServicoExtraido[];
  totalExtraido: number;
  resumo: CadastroResumo | null;
}

// Painel de diagnóstico do cadastramento: mostra cada serviço extraído com
// preço esperado, ajuda o orçamentista a comparar visualmente com o que
// está no Orçafascio (limitações da API impedem buscar valores reais via
// código).
export function DiagnosticoCadastro({ servicos, totalExtraido, resumo }: Props) {
  if (!resumo || !resumo.budget_url) return null;

  // Extrai códigos pendentes dos warnings (linha "Items não encontrados…")
  const codesPendentes = new Set<string>();
  for (const w of resumo.warnings ?? []) {
    // Match "BANK/CODE descrição"
    const matches = w.matchAll(/([A-Z]+\d*)\/([A-Z0-9_-]+)/g);
    for (const m of matches) {
      codesPendentes.add(`${m[1]}/${m[2]}`);
    }
  }
  const isPendente = (s: ServicoExtraido): boolean => {
    const key = `${(s.fonte ?? '').toUpperCase().replace('SICRO', 'SICRO3').replace('SICRO33', 'SICRO3')}/${s.codigo ?? ''}`;
    return codesPendentes.has(key);
  };

  const totalServicos = servicos.length;
  const propriaCadastradas = servicos.filter(
    (s) => s.fonte === 'PROPRIA' && s.orcafascio_composition_id,
  ).length;
  const totalPropria = servicos.filter((s) => s.fonte === 'PROPRIA').length;
  const itensProvavelmenteIncompletos = servicos.filter(isPendente);

  return (
    <section className="space-y-4 rounded-lg border border-zinc-200 bg-white p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900">
            🧾 Cadastramento no Orçafascio
          </h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            {resumo.cadastrado_em && `Última execução: ${formatDate(resumo.cadastrado_em)}`}
          </p>
        </div>
        <a
          href={resumo.budget_url}
          target="_blank"
          rel="noreferrer"
          className="rounded-md bg-purple-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-purple-700"
        >
          Abrir orçamento no Orçafascio →
        </a>
      </div>

      <dl className="grid grid-cols-2 gap-3 text-xs md:grid-cols-4">
        <div className="rounded-md bg-zinc-50 p-3">
          <dt className="text-zinc-500">Total esperado (edital)</dt>
          <dd className="mt-0.5 font-semibold text-zinc-900">{formatBRL(totalExtraido)}</dd>
        </div>
        <div className="rounded-md bg-zinc-50 p-3">
          <dt className="text-zinc-500">Serviços extraídos</dt>
          <dd className="mt-0.5 font-semibold text-zinc-900">{totalServicos}</dd>
        </div>
        <div className="rounded-md bg-zinc-50 p-3">
          <dt className="text-zinc-500">PROPRIA cadastradas</dt>
          <dd className="mt-0.5 font-semibold text-zinc-900">
            {propriaCadastradas} / {totalPropria}
          </dd>
        </div>
        <div className="rounded-md bg-zinc-50 p-3">
          <dt className="text-zinc-500">BDI / leis sociais</dt>
          <dd className="mt-0.5 font-semibold text-zinc-900">
            {resumo.bdi?.toFixed(2)}% / {resumo.leis_sociais_horista?.toFixed(2)}%
          </dd>
        </div>
      </dl>

      {resumo.bancos_configurados && resumo.bancos_configurados.length > 0 && (
        <p className="text-xs text-zinc-600">
          <strong>Bancos:</strong> {resumo.bancos_configurados.join(' · ')}
        </p>
      )}

      {itensProvavelmenteIncompletos.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          <p className="font-medium">
            ⚠ {itensProvavelmenteIncompletos.length} item(ns) provavelmente com valor zerado no Orçafascio
          </p>
          <p className="mt-1 text-[11px]">
            Códigos descontinuados que a API do Orçafascio não resolveu. Compare com a tabela abaixo + abra o orçamento no Orçafascio pra editar manualmente.
          </p>
        </div>
      )}

      <details className="rounded-md border border-zinc-200">
        <summary className="cursor-pointer bg-zinc-50 px-3 py-2 text-xs font-medium text-zinc-700">
          📋 Lista completa dos serviços do edital ({totalServicos})
        </summary>
        <div className="overflow-x-auto">
          <table className="min-w-full text-[11px]">
            <thead className="bg-zinc-50 text-left text-zinc-600">
              <tr>
                <th className="px-2 py-1.5 font-medium">Item</th>
                <th className="px-2 py-1.5 font-medium">Descrição</th>
                <th className="px-2 py-1.5 font-medium">Fonte</th>
                <th className="px-2 py-1.5 font-medium">Código</th>
                <th className="px-2 py-1.5 text-right font-medium">Qtd</th>
                <th className="px-2 py-1.5 text-right font-medium">PU edital</th>
                <th className="px-2 py-1.5 text-right font-medium">Total edital</th>
                <th className="px-2 py-1.5 text-center font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {servicos.map((s) => {
                const pendente = isPendente(s);
                const cadastrada = s.fonte === 'PROPRIA' && s.orcafascio_composition_id;
                return (
                  <tr key={s.item_codigo} className={pendente ? 'bg-amber-50/60' : ''}>
                    <td className="px-2 py-1 font-mono text-zinc-700">{s.item_codigo}</td>
                    <td className="px-2 py-1 max-w-xs truncate text-zinc-800" title={s.descricao}>
                      {s.descricao}
                    </td>
                    <td className="px-2 py-1">
                      <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        s.fonte === 'PROPRIA'
                          ? 'bg-blue-100 text-blue-800'
                          : 'bg-zinc-100 text-zinc-700'
                      }`}>
                        {s.fonte ?? '—'}
                      </span>
                    </td>
                    <td className="px-2 py-1 font-mono text-zinc-600">{s.codigo ?? '—'}</td>
                    <td className="px-2 py-1 text-right">{s.quantidade?.toFixed(2) ?? '—'}</td>
                    <td className="px-2 py-1 text-right">{s.preco_unitario_com_bdi != null ? formatBRL(s.preco_unitario_com_bdi) : '—'}</td>
                    <td className="px-2 py-1 text-right font-medium">{s.preco_total != null ? formatBRL(s.preco_total) : '—'}</td>
                    <td className="px-2 py-1 text-center">
                      {pendente ? (
                        <span className="rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-medium text-amber-900">
                          editar manual
                        </span>
                      ) : cadastrada ? (
                        <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800">
                          OK
                        </span>
                      ) : s.fonte === 'PROPRIA' ? (
                        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-600">
                          —
                        </span>
                      ) : (
                        <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-700">
                          direto
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-zinc-50 font-semibold">
              <tr>
                <td className="px-2 py-2" colSpan={6}>TOTAL</td>
                <td className="px-2 py-2 text-right">{formatBRL(totalExtraido)}</td>
                <td className="px-2 py-2"></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </details>

      {resumo.warnings && resumo.warnings.length > 0 && (
        <details className="rounded-md border border-amber-200 bg-amber-50">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-amber-900">
            ⚠ {resumo.warnings.length} aviso(s) do último cadastramento
          </summary>
          <ul className="space-y-1 px-3 py-2 text-[11px] text-amber-900">
            {resumo.warnings.map((w, i) => (
              <li key={i} className="border-l-2 border-amber-300 pl-2">{w}</li>
            ))}
          </ul>
        </details>
      )}

      <p className="text-[11px] text-zinc-500">
        <strong>Próximos passos:</strong> compare os totais por trecho/grupo na UI do Orçafascio com a tabela acima.
        Para itens com status &ldquo;editar manual&rdquo;, abra o orçamento e edite o preço unitário do item pra bater com o edital.
        Códigos descontinuados podem ser mapeados em <a href="/dashboard/code-mappings" className="text-purple-700 underline">/dashboard/code-mappings</a> pra próximos editais usarem substituição automática.
      </p>
    </section>
  );
}
