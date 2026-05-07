'use client';

import { useState, useTransition, type ChangeEvent } from 'react';
import { createLicitacao } from './actions';

export function UploadForm() {
  const [titulo, setTitulo] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    setError(null);
    const f = e.target.files?.[0] ?? null;
    if (f && f.type !== 'application/pdf') {
      setError('Só aceitamos PDF.');
      e.target.value = '';
      return;
    }
    if (f && f.size > 100 * 1024 * 1024) {
      setError('Arquivo passa de 100 MB. Reduza ou divida.');
      e.target.value = '';
      return;
    }
    setFile(f);
  }

  return (
    <form
      className="space-y-5 rounded-lg border border-zinc-200 bg-white p-6"
      action={(formData) => {
        if (!file) {
          setError('Selecione o PDF do edital.');
          return;
        }
        if (!titulo.trim()) {
          setError('Informe um título descritivo.');
          return;
        }
        startTransition(async () => {
          const result = await createLicitacao(formData);
          if (result?.error) setError(result.error);
        });
      }}
    >
      <label className="block">
        <span className="text-sm font-medium text-zinc-700">Título descritivo</span>
        <input
          type="text"
          name="titulo"
          required
          value={titulo}
          onChange={(e) => setTitulo(e.target.value)}
          placeholder="Ex.: Construção CSPII — Pedro II/PI"
          className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900"
          disabled={isPending}
        />
      </label>

      <label className="block">
        <span className="text-sm font-medium text-zinc-700">PDF do edital</span>
        <input
          type="file"
          name="arquivo"
          accept="application/pdf"
          required
          onChange={onFileChange}
          disabled={isPending}
          className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-zinc-100 file:px-3 file:py-1.5 file:text-sm file:text-zinc-700 hover:file:bg-zinc-200"
        />
        {file && (
          <p className="mt-1 text-xs text-zinc-500">
            {file.name} — {(file.size / 1024 / 1024).toFixed(2)} MB
          </p>
        )}
      </label>

      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-800">{error}</div>
      )}

      <button
        type="submit"
        disabled={isPending || !file || !titulo.trim()}
        className="w-full rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {isPending ? 'Subindo…' : 'Criar licitação e subir PDF'}
      </button>
    </form>
  );
}
