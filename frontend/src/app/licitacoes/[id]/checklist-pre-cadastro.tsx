import { formatBRL } from '@/lib/utils';

interface ServicoExtraido {
  item_codigo: string;
  descricao: string;
  fonte: string | null;
  preco_total: number | null;
}

interface Cabecalho {
  municipio?: string | null;
  uf?: string | null;
  data_base_descricao?: string | null;
  bdi_percentual?: number | string | null;
  leis_sociais_percentual?: number | string | null;
  com_desoneracao?: boolean | null;
  bases_utilizadas?: string[] | null;
  orgao?: string | null;
}

interface Props {
  servicos: ServicoExtraido[];
  totalExtraido: number;
  cabecalho: Cabecalho | null;
  // Quando true, mostra o card colapsado (já validou)
  jaCadastrou?: boolean;
}

// Painel de pré-cadastro: mostra dados que o orçamentista DEVE conferir
// manualmente antes de mandar pro Orçafascio. Reduz retrabalho — bot fica
// claro sobre quais campos podem estar errados.
//
// Validações automáticas:
// - Gaps numéricos no item_codigo (ex: pulou item 6 entre 5 e 7)
// - Contagem de grupos top-level vs JSON
// - Distribuição por fonte (PROPRIA vs bancos)
// - Items sem preço/quantidade
export function ChecklistPreCadastro({
  servicos,
  totalExtraido,
  cabecalho,
  jaCadastrou,
}: Props) {
  if (!cabecalho || servicos.length === 0) return null;

  // Detecta gaps nos grupos top-level (1, 2, 3, ...)
  const gruposTop = new Set<number>();
  for (const s of servicos) {
    const top = parseInt(s.item_codigo.split('.')[0], 10);
    if (!isNaN(top)) gruposTop.add(top);
  }
  const gruposOrdenados = [...gruposTop].sort((a, b) => a - b);
  const gaps: number[] = [];
  if (gruposOrdenados.length >= 2) {
    const min = gruposOrdenados[0];
    const max = gruposOrdenados[gruposOrdenados.length - 1];
    for (let i = min; i <= max; i++) {
      if (!gruposTop.has(i)) gaps.push(i);
    }
  }

  // Distribuição por fonte
  const porFonte = new Map<string, number>();
  for (const s of servicos) {
    const k = s.fonte ?? 'sem fonte';
    porFonte.set(k, (porFonte.get(k) ?? 0) + 1);
  }

  // Items sem preço ou qty
  const semPreco = servicos.filter((s) => !s.preco_total || s.preco_total <= 0).length;

  const bdi = cabecalho.bdi_percentual != null ? Number(cabecalho.bdi_percentual) : null;
  const leis = cabecalho.leis_sociais_percentual != null ? Number(cabecalho.leis_sociais_percentual) : null;
  const regime = cabecalho.com_desoneracao === true
    ? 'DESONERADO'
    : cabecalho.com_desoneracao === false
      ? 'ONERADO'
      : '⚠ não detectado';
  const bases = Array.isArray(cabecalho.bases_utilizadas) ? cabecalho.bases_utilizadas : [];

  return (
    <section className={`rounded-lg border bg-white ${jaCadastrou ? 'border-zinc-200' : 'border-amber-300'}`}>
      <details open={!jaCadastrou}>
        <summary className="cursor-pointer p-6 pb-3">
          <div className="flex items-baseline justify-between gap-4">
            <div>
              <h2 className="inline text-sm font-semibold text-zinc-900">
                ✓ Checklist pré-cadastro
              </h2>
              {!jaCadastrou && (
                <span className="ml-2 text-xs text-amber-700">
                  (revise os dados antes de cadastrar — o bot pode ter extraído errado)
                </span>
              )}
            </div>
            {gaps.length > 0 && (
              <span className="rounded bg-red-100 px-2 py-0.5 text-[10px] font-medium text-red-900">
                ⚠ {gaps.length} grupo(s) faltando
              </span>
            )}
          </div>
        </summary>

        <div className="space-y-4 p-6 pt-2">
          {/* Cabeçalho do edital — campos críticos que precisam validação manual */}
          <div className="grid grid-cols-2 gap-3 text-xs md:grid-cols-4">
            <Field label="Município / UF" value={`${cabecalho.municipio ?? '—'} / ${cabecalho.uf ?? '—'}`} alert={!cabecalho.uf} />
            <Field label="Data-base" value={cabecalho.data_base_descricao ?? '—'} alert={!cabecalho.data_base_descricao} />
            <Field label="BDI" value={bdi != null ? `${bdi.toFixed(2)}%` : '—'} alert={bdi == null || bdi <= 0 || bdi > 50} />
            <Field
              label="Regime tributário"
              value={regime}
              alert={cabecalho.com_desoneracao == null}
            />
            <Field
              label="Leis sociais (horista)"
              value={leis != null ? `${leis.toFixed(2)}%` : '—'}
              alert={leis == null || leis < 80 || leis > 130}
            />
            <Field
              label="Bases utilizadas"
              value={bases.length > 0 ? bases.join(' + ') : '—'}
              alert={bases.length === 0}
            />
            <Field label="Total geral (com BDI)" value={formatBRL(totalExtraido)} alert={totalExtraido <= 0} />
            <Field
              label="Órgão licitante"
              value={cabecalho.orgao ?? '—'}
              alert={!cabecalho.orgao}
            />
          </div>

          {/* Análise da extração */}
          <div className="space-y-2 rounded-md bg-zinc-50 p-3 text-xs">
            <p className="font-medium text-zinc-700">📊 Análise da extração</p>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <Mini label="Total de serviços" value={servicos.length.toString()} />
              <Mini label="Grupos top-level" value={gruposOrdenados.length.toString()} />
              <Mini
                label="Sem preço"
                value={semPreco.toString()}
                alert={semPreco > 0}
              />
              <Mini
                label="Faixa de grupos"
                value={
                  gruposOrdenados.length > 0
                    ? `${gruposOrdenados[0]}–${gruposOrdenados[gruposOrdenados.length - 1]}`
                    : '—'
                }
              />
            </div>
            <div className="flex flex-wrap gap-1 text-[10px]">
              {[...porFonte.entries()].map(([fonte, count]) => (
                <span
                  key={fonte}
                  className={`rounded px-2 py-0.5 ${
                    fonte === 'PROPRIA' ? 'bg-blue-100 text-blue-800' : 'bg-zinc-200 text-zinc-700'
                  }`}
                >
                  {fonte}: {count}
                </span>
              ))}
            </div>
          </div>

          {/* Alertas estruturais */}
          {gaps.length > 0 && (
            <div className="rounded-md border border-red-300 bg-red-50 p-3 text-xs text-red-900">
              <p className="font-medium">
                ⚠ Grupos {gaps.join(', ')} faltando na extração
              </p>
              <p className="mt-1 text-[11px]">
                O JSON pula direto do item {gruposOrdenados.find((g) => g < gaps[0])} para o{' '}
                {gruposOrdenados.find((g) => g > gaps[gaps.length - 1])}. Pode ser que o NotebookLM/Claude tenha
                cortado a extração. <strong>Volte pro extracao manual e cole o JSON completo</strong> antes de
                cadastrar.
              </p>
            </div>
          )}

          {!jaCadastrou && (
            <div className="rounded-md bg-amber-50 p-3 text-[11px] text-amber-900">
              <p className="font-medium">⚠ Antes de cadastrar:</p>
              <ul className="mt-1 list-disc pl-4 space-y-0.5">
                <li>Confira data-base, regime (onerado/desonerado), BDI e leis sociais acima</li>
                <li>Os preços unitários do Orçafascio podem divergir do edital (data/base diferentes) — sempre conferir total no painel pós-cadastro</li>
                <li>Composições PRÓPRIAS são cadastradas no MyBase com o código do edital (ou COMPOSIC_&lt;item&gt; se não houver) — pode precisar editar manualmente os sub-itens</li>
              </ul>
            </div>
          )}
        </div>
      </details>
    </section>
  );
}

function Field({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className={`rounded-md border p-2 ${alert ? 'border-amber-300 bg-amber-50' : 'border-zinc-200 bg-white'}`}>
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`mt-0.5 text-xs font-medium ${alert ? 'text-amber-900' : 'text-zinc-900'}`}>
        {alert && '⚠ '}{value}
      </div>
    </div>
  );
}

function Mini({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className={`rounded px-2 py-1 ${alert ? 'bg-amber-100' : 'bg-white'}`}>
      <div className="text-[9px] uppercase text-zinc-500">{label}</div>
      <div className={`text-sm font-semibold ${alert ? 'text-amber-900' : 'text-zinc-800'}`}>
        {value}
      </div>
    </div>
  );
}
