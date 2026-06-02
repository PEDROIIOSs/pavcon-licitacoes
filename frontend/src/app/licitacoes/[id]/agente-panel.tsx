'use client';

import Link from 'next/link';
import { useEffect, useState, useTransition } from 'react';
import {
  analisarLicitacao,
  ignorarDiagnostico,
  marcarResolvido,
} from '@/lib/agente/actions';

interface Diagnostico {
  id: number;
  tipo: string;
  severidade: 'info' | 'aviso' | 'erro' | 'sucesso';
  titulo: string;
  mensagem?: string | null;
  sugestao?: string | null;
  acao_acionavel?: {
    tipo: string;
    params: Record<string, unknown>;
    label: string;
  } | null;
  contexto?: Record<string, unknown> | null;
  status: string;
  detectado_em: string;
}

interface Props {
  licitacaoId: string;
  diagnosticosIniciais: Diagnostico[];
}

const SEV_STYLES: Record<string, { bg: string; border: string; text: string; icon: string }> = {
  info: { bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-900', icon: 'ℹ️' },
  aviso: { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-900', icon: '⚠️' },
  erro: { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-900', icon: '🚨' },
  sucesso: { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-900', icon: '✓' },
};

export function AgentePanel({ licitacaoId, diagnosticosIniciais }: Props) {
  const [diagnosticos, setDiagnosticos] = useState(diagnosticosIniciais);
  const [isPending, startTransition] = useTransition();
  const [analisando, setAnalisando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Roda análise automática ao montar (a cada visita à página)
  useEffect(() => {
    setAnalisando(true);
    analisarLicitacao(licitacaoId)
      .then((r) => {
        if (r.error) setError(r.error);
        else if (r.diagnosticos) setDiagnosticos(r.diagnosticos);
      })
      .finally(() => setAnalisando(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [licitacaoId]);

  function handleAnalisar() {
    setError(null);
    setAnalisando(true);
    startTransition(async () => {
      const r = await analisarLicitacao(licitacaoId);
      if (r.error) setError(r.error);
      else if (r.diagnosticos) setDiagnosticos(r.diagnosticos);
      setAnalisando(false);
    });
  }

  function handleResolver(diag: Diagnostico, aprender: boolean) {
    startTransition(async () => {
      const r = await marcarResolvido(diag.id, aprender);
      if (r.error) setError(r.error);
      else setDiagnosticos((prev) => prev.filter((d) => d.id !== diag.id));
    });
  }

  function handleIgnorar(diag: Diagnostico) {
    startTransition(async () => {
      const r = await ignorarDiagnostico(diag.id);
      if (r.error) setError(r.error);
      else setDiagnosticos((prev) => prev.filter((d) => d.id !== diag.id));
    });
  }

  const porSeveridade: Record<string, Diagnostico[]> = {
    erro: [], aviso: [], info: [], sucesso: [],
  };
  for (const d of diagnosticos) {
    (porSeveridade[d.severidade] ?? []).push(d);
  }

  return (
    <section className="rounded-lg border-2 border-purple-200 bg-gradient-to-br from-purple-50 to-white p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-purple-900">
            🤖 Agente de Suporte
          </h2>
          <p className="mt-0.5 text-xs text-purple-700">
            Analisa a licitação automaticamente, identifica problemas conhecidos e sugere correções.
            Aprende quando você marca como resolvido.
          </p>
        </div>
        <button
          onClick={handleAnalisar}
          disabled={isPending || analisando}
          className="rounded-md border border-purple-300 bg-white px-3 py-1.5 text-xs font-medium text-purple-900 hover:bg-purple-100 disabled:opacity-50"
        >
          {analisando ? 'Analisando…' : '↻ Reanalisar'}
        </button>
      </div>

      {error && (
        <div className="mt-3 rounded-md bg-red-50 p-2 text-xs text-red-800">{error}</div>
      )}

      {diagnosticos.length === 0 && !analisando && (
        <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          ✓ Nenhum problema detectado. Boa pra cadastrar.
        </div>
      )}

      <div className="mt-4 space-y-3">
        {(['erro', 'aviso', 'info', 'sucesso'] as const).flatMap((sev) =>
          porSeveridade[sev].map((d) => {
            const style = SEV_STYLES[d.severidade];
            return (
              <div
                key={d.id}
                className={`rounded-md border ${style.border} ${style.bg} p-3 text-xs ${style.text}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">
                      {style.icon} {d.titulo}
                    </p>
                    {d.mensagem && (
                      <p className="mt-1 opacity-90">{d.mensagem}</p>
                    )}
                    {d.sugestao && (
                      <p className="mt-1.5 rounded bg-white/60 p-1.5 text-[11px]">
                        <strong>Sugestão:</strong> {d.sugestao}
                      </p>
                    )}
                    {d.contexto && Object.keys(d.contexto).length > 0 && (
                      <details className="mt-1.5 text-[10px] opacity-75">
                        <summary className="cursor-pointer">Contexto</summary>
                        <pre className="mt-1 overflow-x-auto rounded bg-white/40 p-1.5">
                          {JSON.stringify(d.contexto, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                  <div className="flex flex-col gap-1">
                    {d.acao_acionavel?.tipo === 'abrir_mapeamentos' && (
                      <Link
                        href="/dashboard/code-mappings"
                        className="rounded bg-white px-2 py-1 text-[10px] font-medium hover:bg-zinc-50"
                      >
                        {d.acao_acionavel.label}
                      </Link>
                    )}
                    <button
                      onClick={() => handleResolver(d, true)}
                      disabled={isPending}
                      className="rounded bg-emerald-600 px-2 py-1 text-[10px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                      title="Marca resolvido e ensina o agente a reconhecer esse padrão em editais futuros"
                    >
                      ✓ Resolvi
                    </button>
                    <button
                      onClick={() => handleIgnorar(d)}
                      disabled={isPending}
                      className="rounded border border-zinc-300 bg-white px-2 py-1 text-[10px] hover:bg-zinc-50 disabled:opacity-50"
                      title="Ignora pra essa licitação (não some pra outros editais)"
                    >
                      Ignorar
                    </button>
                  </div>
                </div>
              </div>
            );
          }),
        )}
      </div>
    </section>
  );
}
