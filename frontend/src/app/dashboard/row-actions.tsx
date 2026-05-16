'use client';

import { useTransition } from 'react';
import { deleteLicitacao } from './actions';

export function RowActions({
  licitacaoId,
  titulo,
}: {
  licitacaoId: string;
  titulo: string;
}) {
  const [isPending, startTransition] = useTransition();

  return (
    <form
      action={(formData) => {
        const preview = titulo.length > 60 ? titulo.slice(0, 60) + '…' : titulo;
        if (
          !confirm(
            `Deletar essa licitação?\n\n"${preview}"\n\nIsso remove:\n• PDFs do Storage\n• Composições extraídas\n• Extrações de OCR\n• A licitação inteira\n\nNão dá pra desfazer. Continuar?`,
          )
        ) {
          return;
        }
        startTransition(() => deleteLicitacao(formData));
      }}
      className="inline"
    >
      <input type="hidden" name="licitacaoId" value={licitacaoId} />
      <button
        type="submit"
        disabled={isPending}
        className="text-xs font-medium text-red-700 hover:underline disabled:opacity-50"
      >
        {isPending ? 'Deletando…' : 'Deletar'}
      </button>
    </form>
  );
}
