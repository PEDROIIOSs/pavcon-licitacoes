'use client';

import { useState, useTransition } from 'react';
import { deleteMapping, saveMapping } from './actions';

interface Mapping {
  id: number;
  fonte_original: string;
  codigo_original: string;
  fonte_substituto: string | null;
  codigo_substituto: string | null;
  descricao: string | null;
  motivo: string | null;
}

export function MappingsTable({
  mappings,
  highlight,
}: {
  mappings: Mapping[];
  highlight?: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-md border border-zinc-200 bg-white">
      <table className="min-w-full text-xs">
        <thead className="bg-zinc-50 text-left text-zinc-600">
          <tr>
            <th className="px-3 py-2 font-medium">Fonte original</th>
            <th className="px-3 py-2 font-medium">Code original</th>
            <th className="px-3 py-2 font-medium">Descrição</th>
            <th className="px-3 py-2 font-medium">→ Fonte nova</th>
            <th className="px-3 py-2 font-medium">→ Code novo</th>
            <th className="px-3 py-2 font-medium">Ações</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {mappings.map((m) => (
            <MappingRow key={m.id} mapping={m} highlight={highlight} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MappingRow({ mapping, highlight }: { mapping: Mapping; highlight?: boolean }) {
  const [fonteSubst, setFonteSubst] = useState(mapping.fonte_substituto ?? '');
  const [codSubst, setCodSubst] = useState(mapping.codigo_substituto ?? '');
  const [isPending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<string | null>(null);

  function handleSave() {
    setFeedback(null);
    startTransition(async () => {
      const r = await saveMapping(mapping.id, fonteSubst, codSubst);
      if (r.error) setFeedback(`Erro: ${r.error}`);
      else setFeedback('Salvo ✓');
    });
  }

  function handleDelete() {
    if (!confirm('Apagar este mapeamento?')) return;
    startTransition(async () => {
      const r = await deleteMapping(mapping.id);
      if (r.error) setFeedback(`Erro: ${r.error}`);
    });
  }

  return (
    <tr className={highlight ? 'bg-amber-50/30' : ''}>
      <td className="px-3 py-2 font-mono">{mapping.fonte_original}</td>
      <td className="px-3 py-2 font-mono">{mapping.codigo_original}</td>
      <td className="px-3 py-2 text-zinc-700" title={mapping.descricao ?? ''}>
        <div className="max-w-xs truncate">{mapping.descricao ?? '—'}</div>
        {mapping.motivo && (
          <div className="mt-0.5 text-[10px] text-zinc-400">{mapping.motivo}</div>
        )}
      </td>
      <td className="px-3 py-2">
        <input
          type="text"
          value={fonteSubst}
          onChange={(e) => setFonteSubst(e.target.value)}
          placeholder="SINAPI"
          disabled={isPending}
          className="w-24 rounded border border-zinc-300 px-2 py-1 font-mono text-xs disabled:opacity-50"
        />
      </td>
      <td className="px-3 py-2">
        <input
          type="text"
          value={codSubst}
          onChange={(e) => setCodSubst(e.target.value)}
          placeholder="95417"
          disabled={isPending}
          className="w-28 rounded border border-zinc-300 px-2 py-1 font-mono text-xs disabled:opacity-50"
        />
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleSave}
            disabled={isPending}
            className="rounded bg-emerald-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {isPending ? '…' : 'Salvar'}
          </button>
          <button
            onClick={handleDelete}
            disabled={isPending}
            className="rounded border border-zinc-300 bg-white px-2.5 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
          >
            Apagar
          </button>
          {feedback && (
            <span className={`text-[10px] ${feedback.startsWith('Erro') ? 'text-red-700' : 'text-emerald-700'}`}>
              {feedback}
            </span>
          )}
        </div>
      </td>
    </tr>
  );
}
