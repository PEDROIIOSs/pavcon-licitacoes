'use client';

import { useState, useTransition } from 'react';
import { importarExtracaoManual } from './actions';

interface Props {
  licitacaoId: string;
  source: 'notebooklm' | 'claude_code' | 'outro';
  open: boolean;
  onClose: () => void;
  onSuccess: (composicoes: number, subItens: number) => void;
}

const SOURCE_TITLE: Record<Props['source'], string> = {
  notebooklm: 'Importar JSON do NotebookLM',
  claude_code: 'Importar JSON via Claude Code',
  outro: 'Importar JSON manualmente',
};

const SOURCE_HELP: Record<Props['source'], string> = {
  notebooklm:
    'Abre o NotebookLM, sobe os PDFs do edital e cola o prompt abaixo. Pega o JSON da resposta e cola aqui.',
  claude_code:
    'Abre o Claude (chat ou Claude Code), anexa os PDFs do edital e cola o prompt abaixo. Pega o JSON da resposta e cola aqui.',
  outro: 'Cola aqui o JSON gerado por qualquer ferramenta de extração — ele deve seguir o schema abaixo.',
};

const PROMPT_TEMPLATE = `Você é um extrator estruturado de planilhas orçamentárias de editais brasileiros de obras públicas.

OBJETIVO: ler o(s) PDF(s) anexado(s) e devolver UM ÚNICO objeto JSON exatamente no schema abaixo. NÃO escreva nada antes ou depois do JSON.

SCHEMA:
{
  "cabecalho": {
    "orgao": string,
    "objeto": string,
    "municipio": string,
    "uf": string,                              // 2 letras (PI, SP, ...)
    "numero_edital": string | null,
    "data_base_descricao": string | null,
    "bases_utilizadas": string[],              // ["SINAPI","SEINFRA","ORSE",...]
    "com_desoneracao": boolean | null,
    "leis_sociais_percentual": number | null,
    "bdi_percentual": number | null
  },
  "itens": [
    {
      "item_codigo": string,                   // ex: "5.1.5"
      "nivel": number,
      "pai": string | null,                    // pai do item, sem o último ".X"
      "tipo": "grupo" | "servico",
      "codigo": string | null,                 // SINAPI/SEINFRA/ORSE ou null
      "fonte": "SINAPI"|"SICRO"|"SEINFRA"|"ORSE"|"SBC"|"PROPRIA"|"OUTRA"|null,
      "descricao": string,
      "unidade": string | null,                // M, M2, KG, CJ, UN, etc.
      "quantidade": number | null,
      "preco_unitario_sem_bdi": number | null,
      "preco_unitario_com_bdi": number | null,
      "preco_total": number | null,
      "composicao_propria": {                  // SOMENTE quando fonte = "PROPRIA"
        "itens": [
          {
            "classe": "INSUMO"|"COMPOSICAO"|"MAT"|"EQUIPAMENTO",
            "codigo": string | null,
            "fonte": "SINAPI"|"SICRO"|"SEINFRA"|"ORSE"|"SBC"|"PROPRIA"|"OUTRA",
            "descricao": string,
            "unidade": string | null,
            "coeficiente": number,
            "preco_unitario": number | null
          }
        ]
      }
    }
  ]
}

REGRAS:
- "tipo=grupo" pra itens agregadores (sem qtd/preço), "tipo=servico" pra linhas com quantidade.
- Hierarquia inferida pelo número: "1" → nível 1, "1.1" → nível 2; pai("1.1.5") = "1.1".
- composicao_propria SÓ existe quando fonte="PROPRIA".
- Números com ponto decimal (não vírgula).
- Devolva o JSON puro, SEM \`\`\`json\`\`\`, sem texto antes ou depois.
`;

export function ImportJsonModal({ licitacaoId, source, open, onClose, onSuccess }: Props) {
  const [jsonText, setJsonText] = useState('');
  const [showPrompt, setShowPrompt] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (!open) return null;

  function copyPrompt() {
    navigator.clipboard.writeText(PROMPT_TEMPLATE).then(() => {
      setError(null);
    });
  }

  function handleSubmit() {
    setError(null);
    if (!jsonText.trim()) {
      setError('Cola o JSON antes de importar.');
      return;
    }
    startTransition(async () => {
      const r = await importarExtracaoManual(licitacaoId, jsonText, source);
      if (r?.error) {
        setError(r.error);
      } else {
        onSuccess(r.composicoes_inseridas ?? 0, r.sub_itens_inseridos ?? 0);
        setJsonText('');
        onClose();
      }
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-zinc-200 px-6 py-4">
          <h2 className="text-base font-semibold text-zinc-900">{SOURCE_TITLE[source]}</h2>
          <button
            onClick={onClose}
            disabled={isPending}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-100"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-auto px-6 py-4">
          <p className="text-sm text-zinc-600">{SOURCE_HELP[source]}</p>

          <div className="mt-4">
            <button
              onClick={() => setShowPrompt((v) => !v)}
              className="text-xs text-blue-600 hover:underline"
            >
              {showPrompt ? '▼ Esconder prompt' : '▶ Ver prompt pronto pra colar no NotebookLM/Claude'}
            </button>
            {showPrompt && (
              <div className="mt-2 space-y-2">
                <pre className="max-h-64 overflow-auto rounded border border-zinc-200 bg-zinc-50 p-3 text-[11px] text-zinc-700">
                  {PROMPT_TEMPLATE}
                </pre>
                <button
                  onClick={copyPrompt}
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                >
                  Copiar prompt
                </button>
              </div>
            )}
          </div>

          <label className="mt-4 block">
            <span className="text-sm font-medium text-zinc-700">Cole o JSON aqui</span>
            <textarea
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              disabled={isPending}
              placeholder='{"cabecalho": {...}, "itens": [...]}'
              className="mt-1 block h-72 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs focus:border-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900"
            />
          </label>

          {error && (
            <div className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800">{error}</div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-6 py-3">
          <button
            onClick={onClose}
            disabled={isPending}
            className="rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Cancelar
          </button>
          <button
            onClick={handleSubmit}
            disabled={isPending || !jsonText.trim()}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {isPending ? 'Importando…' : 'Importar e validar'}
          </button>
        </div>
      </div>
    </div>
  );
}
