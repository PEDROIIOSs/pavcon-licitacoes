'use client';

import { useState, useTransition } from 'react';
import { resetOrcafascio, resetToDraft, resetToReview } from './actions';

interface Props {
  licitacaoId: string;
  status: string;
}

/**
 * Painel "Voltar etapa" — permite o orçamentista desfazer uma etapa quando
 * algo deu errado, sem precisar pedir reset via SQL.
 *
 * 3 níveis de reset:
 *
 * 1. **Refazer cadastramento** (resetOrcafascio): mantém JSON + composições
 *    extraídas, só limpa os IDs do Orçafascio e volta status pra
 *    "criando_composicoes_edital". Use quando o cadastro no Orçafascio
 *    falhou no meio.
 *
 * 2. **Voltar pra revisão do JSON** (resetToReview): mantém o JSON extraído,
 *    permite re-editar a tabela de extração e re-cadastrar. Use quando
 *    descobriu erro no JSON depois do cadastramento.
 *
 * 3. **Recomeçar do zero** (resetToDraft): apaga extração + composições,
 *    volta pra rascunho. Use quando o JSON do LLM veio totalmente errado
 *    e quer rodar extração de novo.
 */
export function StatusActions({ licitacaoId, status }: Props) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Quais opções fazem sentido pra cada status
  const canResetOrcafascio = ['fase1_concluida', 'criando_orcamento_base', 'erro', 'criando_composicoes_edital'].includes(status);
  const canResetToReview = ['fase1_concluida', 'criando_orcamento_base', 'criando_composicoes_edital', 'erro'].includes(status);
  const canResetToDraft = status !== 'rascunho';

  function handleResetOrcafascio() {
    if (!confirm(
      'Refazer o cadastramento no Orçafascio?\n\n' +
      '• MANTÉM o JSON extraído e a tabela de revisão\n' +
      '• LIMPA os IDs MyBase + sessão web do Orçafascio\n' +
      '• Volta pra etapa "criando composições"\n\n' +
      'Não apaga composições já criadas no Orçafascio web — você precisa apagar manualmente lá se quiser refazer do zero.\n\nContinuar?',
    )) return;
    setError(null);
    startTransition(async () => {
      const r = await resetOrcafascio(licitacaoId);
      if (r?.error) setError(r.error);
    });
  }

  function handleResetToReview() {
    if (!confirm(
      'Voltar pra revisão do JSON?\n\n' +
      '• MANTÉM o JSON extraído + tabela de revisão (você pode editar de novo)\n' +
      '• LIMPA orçamento Orçafascio + sessão web\n' +
      '• Volta pra etapa "aguardando revisão humana"\n\n' +
      'Use quando precisa corrigir algum item da extração antes de re-cadastrar.\n\nContinuar?',
    )) return;
    setError(null);
    startTransition(async () => {
      const r = await resetToReview(licitacaoId);
      if (r?.error) setError(r.error);
    });
  }

  function handleResetToDraft() {
    if (!confirm(
      'RECOMEÇAR DO ZERO?\n\n' +
      '⚠ ATENÇÃO — vai APAGAR:\n' +
      '• JSON extraído (extracoes_ocr)\n' +
      '• Tabela de composições (composicoes_extraidas)\n' +
      '• Sub-itens das composições próprias\n' +
      '• IDs do Orçafascio\n\n' +
      'Mantém apenas os PDFs já uploadados. Use quando o LLM extraiu errado e você quer rodar a extração de novo do zero.\n\nCONTINUAR?',
    )) return;
    setError(null);
    startTransition(async () => {
      const r = await resetToDraft(licitacaoId);
      if (r?.error) setError(r.error);
    });
  }

  // Não mostra nada se status é "rascunho" (nada pra desfazer)
  if (status === 'rascunho') return null;

  return (
    <section className="rounded-lg border border-zinc-200 bg-zinc-50 p-4">
      <details>
        <summary className="cursor-pointer text-sm font-medium text-zinc-700">
          ↺ Voltar etapa anterior (em caso de erro)
        </summary>
        <div className="mt-3 space-y-3 text-xs">
          <p className="text-zinc-600">
            Status atual: <span className="font-mono">{status}</span>
          </p>

          {error && (
            <div className="rounded-md bg-red-50 p-2 text-red-800">{error}</div>
          )}

          {canResetOrcafascio && (
            <div className="rounded-md border border-blue-200 bg-blue-50 p-3">
              <p className="font-medium text-blue-900">↻ Refazer cadastramento no Orçafascio</p>
              <p className="mt-1 text-blue-800">
                Mantém JSON + revisão. Limpa IDs MyBase e sessão. Volta pra etapa &quot;criando composições&quot;.
              </p>
              <button
                onClick={handleResetOrcafascio}
                disabled={isPending}
                className="mt-2 rounded bg-blue-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                Refazer cadastramento
              </button>
            </div>
          )}

          {canResetToReview && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
              <p className="font-medium text-amber-900">↶ Voltar pra revisão do JSON</p>
              <p className="mt-1 text-amber-800">
                Mantém JSON + permite editar tabela de novo. Limpa orçamento Orçafascio. Volta pra &quot;aguardando revisão humana&quot;.
              </p>
              <button
                onClick={handleResetToReview}
                disabled={isPending}
                className="mt-2 rounded bg-amber-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-amber-700 disabled:opacity-50"
              >
                Voltar pra revisão
              </button>
            </div>
          )}

          {canResetToDraft && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3">
              <p className="font-medium text-red-900">⚠ Recomeçar do zero (apaga extração)</p>
              <p className="mt-1 text-red-800">
                APAGA JSON, composições, sub-itens. Mantém só os PDFs uploadados.
                Use quando a extração do LLM saiu totalmente errada.
              </p>
              <button
                onClick={handleResetToDraft}
                disabled={isPending}
                className="mt-2 rounded bg-red-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                Apagar extração e recomeçar
              </button>
            </div>
          )}
        </div>
      </details>
    </section>
  );
}
