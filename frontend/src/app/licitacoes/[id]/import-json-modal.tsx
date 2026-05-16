'use client';

import { useState, useTransition } from 'react';
import { importarExtracaoManual } from './actions';
import { EXTRACTION_PROMPT } from './prompt';

interface ArquivoLink {
  id: string;
  filename_original: string;
  downloadUrl: string | null;
}

interface Props {
  licitacaoId: string;
  source: 'notebooklm' | 'claude_code' | 'outro';
  arquivos: ArquivoLink[];
  promptCopied: boolean;
  open: boolean;
  onClose: () => void;
  onSuccess: (composicoes: number, subItens: number) => void;
}

const SOURCE_TITLE: Record<Props['source'], string> = {
  notebooklm: 'Extração via NotebookLM',
  claude_code: 'Extração via Claude',
  outro: 'Importar JSON manualmente',
};

export function ImportJsonModal({
  licitacaoId,
  source,
  arquivos,
  promptCopied,
  open,
  onClose,
  onSuccess,
}: Props) {
  const [jsonText, setJsonText] = useState('');
  const [showPrompt, setShowPrompt] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (!open) return null;

  const isManualImport = source === 'outro';
  const toolName =
    source === 'notebooklm'
      ? 'NotebookLM'
      : source === 'claude_code'
        ? 'Claude'
        : '';

  function copyPrompt() {
    navigator.clipboard.writeText(EXTRACTION_PROMPT).then(() => {
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

        <div className="flex-1 space-y-4 overflow-auto px-6 py-4">
          {!isManualImport && (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-xs">
              <p className="font-medium text-emerald-900">
                ✓ Aba do {toolName} aberta em nova janela
              </p>
              <p className="mt-1 text-emerald-800">
                {promptCopied
                  ? `✓ Prompt copiado pro clipboard (Ctrl+V na ${toolName})`
                  : source === 'claude_code'
                    ? '✓ O prompt já vai aparecer pre-preenchido na caixa de mensagem do Claude.'
                    : '⚠ Não consegui copiar o prompt automaticamente — use o botão "Copiar prompt" abaixo.'}
              </p>
            </div>
          )}

          {!isManualImport && arquivos.length > 0 && (
            <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
              <p className="text-xs font-medium text-zinc-700">
                Passo 1 — Baixe os PDFs e arraste pro {toolName}:
              </p>
              <ul className="mt-2 space-y-1">
                {arquivos.map((a) => (
                  <li key={a.id}>
                    {a.downloadUrl ? (
                      <a
                        href={a.downloadUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-2 text-xs text-blue-700 hover:underline"
                      >
                        ⬇ {a.filename_original}
                      </a>
                    ) : (
                      <span className="text-xs text-zinc-500">
                        {a.filename_original} (link expirado — recarregue a página)
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!isManualImport && (
            <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-700">
              <p className="font-medium">
                Passo 2 — Na aba do {toolName}:
              </p>
              <ol className="mt-2 list-decimal space-y-0.5 pl-5">
                {source === 'notebooklm' ? (
                  <>
                    <li>Clica em &ldquo;New notebook&rdquo;</li>
                    <li>Arrasta os PDFs baixados como fontes</li>
                    <li>Cola o prompt (Ctrl+V) e envia</li>
                  </>
                ) : (
                  <>
                    <li>Arrasta os PDFs baixados pra caixa de mensagem (ou clica no clipe 📎)</li>
                    <li>O prompt já está pré-preenchido — só clica em enviar</li>
                  </>
                )}
              </ol>
              <p className="mt-2">
                Passo 3 — Copia o JSON da resposta e cola aqui embaixo.
              </p>
            </div>
          )}

          {isManualImport && (
            <p className="text-sm text-zinc-600">
              Cola aqui o JSON gerado por qualquer ferramenta de extração — ele deve seguir o schema do prompt.
            </p>
          )}

          <div>
            <button
              onClick={() => setShowPrompt((v) => !v)}
              className="text-xs text-blue-600 hover:underline"
            >
              {showPrompt ? '▼ Esconder prompt' : '▶ Ver / copiar prompt manualmente'}
            </button>
            {showPrompt && (
              <div className="mt-2 space-y-2">
                <pre className="max-h-64 overflow-auto rounded border border-zinc-200 bg-zinc-50 p-3 text-[11px] text-zinc-700">
                  {EXTRACTION_PROMPT}
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

          <label className="block">
            <span className="text-sm font-medium text-zinc-700">Cole o JSON da resposta aqui</span>
            <textarea
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              disabled={isPending}
              placeholder='{"cabecalho": {...}, "itens": [...]}'
              className="mt-1 block h-64 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs focus:border-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900"
            />
          </label>

          {error && (
            <div className="rounded-md bg-red-50 p-3 text-sm text-red-800">{error}</div>
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
