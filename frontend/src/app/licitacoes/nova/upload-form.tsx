'use client';

import { useState, useTransition, type ChangeEvent } from 'react';
import { createClient } from '@/lib/supabase/client';
import { createLicitacao } from './actions';

type ArquivoTipo =
  | 'planilha_orcamentaria'
  | 'memorial_descritivo'
  | 'projeto_tecnico'
  | 'edital'
  | 'anexo';

const TIPOS: { value: ArquivoTipo; label: string; description: string }[] = [
  { value: 'planilha_orcamentaria', label: 'Planilha orçamentária', description: 'Tabela principal com itens, qtds e preços' },
  { value: 'memorial_descritivo', label: 'Memorial / composições', description: 'Memorial descritivo, composições próprias, encargos' },
  { value: 'anexo', label: 'BDI / Leis sociais / Outro anexo', description: 'Demonstrativo de BDI, leis sociais, etc.' },
  { value: 'projeto_tecnico', label: 'Projeto técnico', description: 'Projetos, plantas, especificações' },
  { value: 'edital', label: 'Edital (texto)', description: 'O edital propriamente dito (caso queira anexar)' },
];

interface ArquivoSelecionado {
  file: File;
  tipo: ArquivoTipo;
}

// Hash SHA-256 do arquivo (calculado no browser via WebCrypto — não passa
// pelo server, mantendo a server action leve). Pra PDFs de 50MB roda em
// ~1-2s.
async function hashFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function UploadForm() {
  const [titulo, setTitulo] = useState('');
  const [arquivos, setArquivos] = useState<ArquivoSelecionado[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [progress, setProgress] = useState<string | null>(null);

  function onFilesChange(e: ChangeEvent<HTMLInputElement>) {
    setError(null);
    const newFiles = Array.from(e.target.files ?? []);
    const validos: ArquivoSelecionado[] = [];
    for (const f of newFiles) {
      if (f.type !== 'application/pdf') {
        setError(`"${f.name}" não é PDF — só PDF é aceito.`);
        e.target.value = '';
        return;
      }
      if (f.size > 100 * 1024 * 1024) {
        setError(`"${f.name}" tem mais de 100 MB.`);
        e.target.value = '';
        return;
      }
      // Heurística pra sugerir tipo a partir do nome
      const lower = f.name.toLowerCase();
      let tipo: ArquivoTipo = 'planilha_orcamentaria';
      if (lower.match(/bdi|encargo|leis.?soci/)) tipo = 'anexo';
      else if (lower.match(/memorial|composi/)) tipo = 'memorial_descritivo';
      else if (lower.match(/projeto|planta/)) tipo = 'projeto_tecnico';
      else if (lower.match(/edital/) && !lower.match(/planilha|or[çc]amento/)) tipo = 'edital';
      validos.push({ file: f, tipo });
    }
    setArquivos((prev) => [...prev, ...validos]);
    e.target.value = '';
  }

  function removeArquivo(idx: number) {
    setArquivos((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateTipo(idx: number, tipo: ArquivoTipo) {
    setArquivos((prev) => prev.map((a, i) => i === idx ? { ...a, tipo } : a));
  }

  function handleSubmit() {
    if (arquivos.length === 0) {
      setError('Selecione pelo menos 1 PDF.');
      return;
    }
    if (!titulo.trim()) {
      setError('Informe um título descritivo.');
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
          setError('Sessão expirada — faça login de novo.');
          return;
        }

        // Sufixo único pra esta sessão de upload — todos os arquivos vão na
        // mesma "pasta temp" no Storage, e movemos pra <licitacao_id>/ quando
        // a row da licitação é criada. Como ainda não temos o id, usa o
        // user.id + timestamp como prefixo.
        const stamp = `${user.id}/${Date.now()}`;
        const uploadedMeta: Array<{
          storage_path: string;
          filename: string;
          size: number;
          mime_type: string;
          hash_sha256: string;
          tipo: ArquivoTipo;
        }> = [];

        for (let i = 0; i < arquivos.length; i++) {
          const a = arquivos[i];
          setProgress(`(${i + 1}/${arquivos.length}) calculando hash de ${a.file.name}…`);
          const hashHex = await hashFile(a.file);

          setProgress(`(${i + 1}/${arquivos.length}) subindo ${a.file.name} (${(a.file.size / 1024 / 1024).toFixed(1)} MB)…`);
          const safeName = a.file.name.replace(/[^\w.-]+/g, '_');
          const storagePath = `${stamp}_${i}_${safeName}`;

          const { error: upErr } = await supabase.storage
            .from('editais')
            .upload(storagePath, a.file, {
              contentType: 'application/pdf',
              upsert: false,
            });
          if (upErr) {
            // Cleanup parciais
            if (uploadedMeta.length > 0) {
              await supabase.storage.from('editais').remove(uploadedMeta.map((m) => m.storage_path));
            }
            setError(`Falha no upload de "${a.file.name}": ${upErr.message}`);
            setProgress(null);
            return;
          }
          uploadedMeta.push({
            storage_path: storagePath,
            filename: a.file.name,
            size: a.file.size,
            mime_type: a.file.type,
            hash_sha256: hashHex,
            tipo: a.tipo,
          });
        }

        setProgress('Criando orçamento…');
        const result = await createLicitacao({
          titulo: titulo.trim(),
          arquivos: uploadedMeta,
        });
        if (result?.error) {
          // Action retornou erro — cleanup
          await supabase.storage.from('editais').remove(uploadedMeta.map((m) => m.storage_path));
          setError(result.error);
          setProgress(null);
        }
        // Sucesso → action faz redirect; nada mais aqui
      } catch (e) {
        setError(`Erro inesperado: ${e instanceof Error ? e.message : String(e)}`);
        setProgress(null);
      }
    });
  }

  return (
    <form
      className="space-y-5 rounded-lg border border-zinc-200 bg-white p-6"
      onSubmit={(e) => {
        e.preventDefault();
        handleSubmit();
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

      <div>
        <span className="text-sm font-medium text-zinc-700">PDFs do órgão</span>
        <p className="text-xs text-zinc-500">
          Adicione todos os arquivos que vieram do órgão: planilha orçamentária, composições, BDI, leis sociais, etc. Pode subir mais de um de cada vez.
        </p>
        <input
          type="file"
          accept="application/pdf"
          multiple
          onChange={onFilesChange}
          disabled={isPending}
          className="mt-2 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-zinc-100 file:px-3 file:py-1.5 file:text-sm file:text-zinc-700 hover:file:bg-zinc-200"
        />
      </div>

      {arquivos.length > 0 && (
        <div className="rounded-md border border-zinc-200 bg-zinc-50">
          <div className="border-b border-zinc-200 bg-zinc-100 px-3 py-2 text-xs font-medium text-zinc-700">
            {arquivos.length} arquivo(s) selecionado(s)
          </div>
          <ul className="divide-y divide-zinc-200">
            {arquivos.map((a, idx) => (
              <li key={idx} className="px-3 py-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-zinc-800">{a.file.name}</p>
                    <p className="text-xs text-zinc-500">
                      {(a.file.size / 1024 / 1024).toFixed(2)} MB
                    </p>
                    <select
                      value={a.tipo}
                      onChange={(e) => updateTipo(idx, e.target.value as ArquivoTipo)}
                      disabled={isPending}
                      className="mt-1 w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs"
                    >
                      {TIPOS.map((t) => (
                        <option key={t.value} value={t.value}>{t.label}</option>
                      ))}
                    </select>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeArquivo(idx)}
                    disabled={isPending}
                    className="rounded p-1 text-xs text-zinc-500 hover:bg-zinc-200 hover:text-zinc-800"
                    title="Remover"
                  >
                    ✕
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {progress && (
        <div className="rounded-md bg-blue-50 p-3 text-xs text-blue-900">{progress}</div>
      )}

      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-800">{error}</div>
      )}

      <button
        type="submit"
        disabled={isPending || arquivos.length === 0 || !titulo.trim()}
        className="w-full rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {isPending ? 'Subindo…' : `Criar orçamento e subir ${arquivos.length} arquivo(s)`}
      </button>
    </form>
  );
}
