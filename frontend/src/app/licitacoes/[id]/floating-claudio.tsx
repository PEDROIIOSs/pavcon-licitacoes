'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, useTransition } from 'react';
import { analisarLicitacao, ignorarDiagnostico, marcarResolvido } from '@/lib/agente/actions';
import {
  definirDataBase,
  executarAutoFix,
  salvarMapeamentosCodes,
} from '@/lib/agente/auto-fixes';
import { type ChatMensagem, chatComClaudio } from '@/lib/agente/chat';

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
}

interface Props {
  licitacaoId: string;
}

const AUTO_FIX_DISPONIVEL: Record<string, { label: string; descricao: string }> = {
  codes_adaptados_nao_reclassificados: {
    label: '🤖 Cláudio resolver agora',
    descricao: 'Reclassifica esses items pra PROPRIA automaticamente',
  },
  aplicar_mapeamentos_pendentes: {
    label: '🤖 Aplicar mapeamentos novos',
    descricao: 'Limpa MyBase IDs pra recriar com os codes mapeados',
  },
};

const SEV_STYLES: Record<string, { dot: string; ring: string }> = {
  erro: { dot: 'bg-red-500', ring: 'ring-red-200' },
  aviso: { dot: 'bg-amber-500', ring: 'ring-amber-200' },
  info: { dot: 'bg-blue-500', ring: 'ring-blue-200' },
  sucesso: { dot: 'bg-emerald-500', ring: 'ring-emerald-200' },
};

const ClaudioAvatar = ({ size = 24, className = '' }: { size?: number; className?: string }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
  >
    <path d="M12 2v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <circle cx="12" cy="2" r="1" fill="currentColor" />
    <rect x="5" y="6" width="14" height="11" rx="2.5" stroke="currentColor" strokeWidth="2" fill="none" />
    <circle cx="9" cy="11" r="1.3" fill="currentColor" />
    <circle cx="15" cy="11" r="1.3" fill="currentColor" />
    <path d="M9 14.5h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M8 17v2M16 17v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <rect x="7" y="19" width="10" height="3" rx="1" stroke="currentColor" strokeWidth="2" fill="none" />
  </svg>
);

type Aba = 'diagnosticos' | 'chat';

export function FloatingClaudio({ licitacaoId }: Props) {
  const [aberto, setAberto] = useState(false);
  const [aba, setAba] = useState<Aba>('diagnosticos');
  const [diagnosticos, setDiagnosticos] = useState<Diagnostico[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [isPending, startTransition] = useTransition();
  const [erro, setErro] = useState<string | null>(null);
  const [sucesso, setSucesso] = useState<string | null>(null);

  // Chat state
  const [historico, setHistorico] = useState<ChatMensagem[]>([]);
  const [perguntaAtual, setPerguntaAtual] = useState('');
  const [chatPensando, setChatPensando] = useState(false);
  const chatBottomRef = useRef<HTMLDivElement>(null);

  // Inline forms state — keyed pelo id do diagnóstico
  const [formAberto, setFormAberto] = useState<Record<number, boolean>>({});
  const [dataBaseInput, setDataBaseInput] = useState<Record<number, string>>({});
  // Mapping form: { diagId -> { 'FONTE/CODIGO_ORIG' -> 'codigo_novo' } }
  const [mappingInput, setMappingInput] = useState<Record<number, Record<string, string>>>({});

  // Persistência aberto/fechado
  useEffect(() => {
    const saved = localStorage.getItem('claudio_aberto');
    if (saved === '1') setAberto(true);
    const savedAba = localStorage.getItem('claudio_aba');
    if (savedAba === 'chat' || savedAba === 'diagnosticos') setAba(savedAba);
  }, []);
  useEffect(() => { localStorage.setItem('claudio_aberto', aberto ? '1' : '0'); }, [aberto]);
  useEffect(() => { localStorage.setItem('claudio_aba', aba); }, [aba]);

  // Análise automática
  useEffect(() => {
    setCarregando(true);
    analisarLicitacao(licitacaoId)
      .then((r) => {
        if (r.error) setErro(r.error);
        else if (r.diagnosticos) setDiagnosticos(r.diagnosticos as Diagnostico[]);
      })
      .finally(() => setCarregando(false));
  }, [licitacaoId]);

  // Scroll chat pro fim quando muda histórico
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [historico, chatPensando]);

  function recarregar() {
    setErro(null);
    setSucesso(null);
    setCarregando(true);
    startTransition(async () => {
      const r = await analisarLicitacao(licitacaoId);
      if (r.error) setErro(r.error);
      else if (r.diagnosticos) setDiagnosticos(r.diagnosticos as Diagnostico[]);
      setCarregando(false);
    });
  }

  function handleAutoFix(diag: Diagnostico) {
    setErro(null);
    setSucesso(null);
    startTransition(async () => {
      const r = await executarAutoFix(licitacaoId, diag.tipo);
      if (r.error) setErro(r.error);
      else {
        setSucesso(r.mensagem ?? `Cláudio aplicou ${r.mudancas ?? 0} mudança(s).`);
        const ar = await analisarLicitacao(licitacaoId);
        if (ar.diagnosticos) setDiagnosticos(ar.diagnosticos as Diagnostico[]);
      }
    });
  }

  function handleResolver(diag: Diagnostico, aprender: boolean) {
    startTransition(async () => {
      const r = await marcarResolvido(diag.id, aprender);
      if (r.error) setErro(r.error);
      else setDiagnosticos((prev) => prev.filter((d) => d.id !== diag.id));
    });
  }

  function handleIgnorar(diag: Diagnostico) {
    startTransition(async () => {
      const r = await ignorarDiagnostico(diag.id);
      if (r.error) setErro(r.error);
      else setDiagnosticos((prev) => prev.filter((d) => d.id !== diag.id));
    });
  }

  function handleDefinirDataBase(diag: Diagnostico) {
    const valor = (dataBaseInput[diag.id] ?? '').trim();
    if (!valor) {
      setErro('Digite a data-base (ex: 04/2026)');
      return;
    }
    setErro(null);
    setSucesso(null);
    startTransition(async () => {
      const r = await definirDataBase(licitacaoId, valor);
      if (r.error) setErro(r.error);
      else {
        setSucesso(r.mensagem ?? 'Data-base definida.');
        setFormAberto((prev) => ({ ...prev, [diag.id]: false }));
        const ar = await analisarLicitacao(licitacaoId);
        if (ar.diagnosticos) setDiagnosticos(ar.diagnosticos as Diagnostico[]);
      }
    });
  }

  function handleSalvarMapeamentos(diag: Diagnostico) {
    const codes = (diag.acao_acionavel?.params?.codes as Array<{
      fonte_original: string; codigo_original: string; descricao?: string | null;
    }> | undefined) ?? [];
    const inputs = mappingInput[diag.id] ?? {};
    const mapeamentos = codes
      .map((c) => {
        const key = `${c.fonte_original}/${c.codigo_original}`;
        const codigoNovo = (inputs[key] ?? '').trim();
        if (!codigoNovo) return null;
        return {
          fonte_original: c.fonte_original,
          codigo_original: c.codigo_original,
          codigo_novo: codigoNovo,
          descricao: c.descricao ?? null,
        };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null);
    if (mapeamentos.length === 0) {
      setErro('Preencha pelo menos 1 código moderno antes de salvar.');
      return;
    }
    setErro(null);
    setSucesso(null);
    startTransition(async () => {
      const r = await salvarMapeamentosCodes(licitacaoId, mapeamentos);
      if (r.error) setErro(r.error);
      else {
        setSucesso(r.mensagem ?? 'Mapeamentos salvos.');
        setFormAberto((prev) => ({ ...prev, [diag.id]: false }));
        const ar = await analisarLicitacao(licitacaoId);
        if (ar.diagnosticos) setDiagnosticos(ar.diagnosticos as Diagnostico[]);
      }
    });
  }

  async function enviarPergunta() {
    const pergunta = perguntaAtual.trim();
    if (!pergunta) return;
    setPerguntaAtual('');
    setErro(null);
    const novoHistorico: ChatMensagem[] = [
      ...historico,
      { role: 'user', content: pergunta, timestamp: new Date().toISOString() },
    ];
    setHistorico(novoHistorico);
    setChatPensando(true);
    try {
      const r = await chatComClaudio(licitacaoId, historico, pergunta);
      if (r.error) {
        setErro(r.error);
        setHistorico(novoHistorico); // mantém pergunta do user
      } else if (r.resposta) {
        const respostaFmt = r.acoes_executadas && r.acoes_executadas.length > 0
          ? `${r.resposta}\n\n_(executei ${r.acoes_executadas.length} ação(ões))_`
          : r.resposta;
        setHistorico([
          ...novoHistorico,
          { role: 'assistant', content: respostaFmt, timestamp: new Date().toISOString() },
        ]);
        if (r.stub) {
          // API key não setada — diagnosticos podem ter mudado mesmo assim
        } else if (r.acoes_executadas && r.acoes_executadas.length > 0) {
          // Recarrega diagnósticos pq Cláudio pode ter aplicado fixes
          const ar = await analisarLicitacao(licitacaoId);
          if (ar.diagnosticos) setDiagnosticos(ar.diagnosticos as Diagnostico[]);
        }
      }
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
    } finally {
      setChatPensando(false);
    }
  }

  const totalErros = diagnosticos.filter((d) => d.severidade === 'erro').length;
  const totalAvisos = diagnosticos.filter((d) => d.severidade === 'aviso').length;
  const temPendencia = diagnosticos.length > 0;

  return (
    <>
      {/* Botão flutuante */}
      {!aberto && (
        <button
          onClick={() => setAberto(true)}
          className="fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-purple-600 text-white shadow-lg ring-4 ring-purple-200 transition hover:scale-110 hover:bg-purple-700"
          title={
            temPendencia
              ? `${totalErros} erro(s), ${totalAvisos} aviso(s) — clique pra abrir o Cláudio`
              : 'Cláudio — assistente de orçamentos'
          }
          aria-label="Abrir Cláudio"
        >
          <ClaudioAvatar size={32} />
          {temPendencia && (
            <span className="absolute -right-1 -top-1 flex h-6 w-6 items-center justify-center rounded-full bg-red-500 text-xs font-bold text-white ring-2 ring-white">
              {diagnosticos.length}
            </span>
          )}
        </button>
      )}

      {/* Painel lateral */}
      {aberto && (
        <aside className="fixed right-0 top-0 z-50 flex h-full w-full flex-col bg-white shadow-2xl sm:w-96">
          <header className="flex items-center justify-between border-b border-purple-200 bg-gradient-to-br from-purple-600 to-purple-700 px-4 py-3 text-white">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/20">
                <ClaudioAvatar size={24} />
              </div>
              <div>
                <h2 className="text-sm font-semibold">Cláudio</h2>
                <p className="text-[10px] opacity-80">Assistente de orçamentos</p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={recarregar}
                disabled={carregando || isPending}
                className="rounded p-1.5 hover:bg-white/10 disabled:opacity-50"
                title="Reanalisar agora"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="23 4 23 10 17 10" />
                  <polyline points="1 20 1 14 7 14" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
              </button>
              <button
                onClick={() => setAberto(false)}
                className="rounded p-1.5 hover:bg-white/10"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </header>

          {/* Tabs */}
          <div className="flex border-b border-zinc-200 bg-zinc-50">
            <button
              onClick={() => setAba('diagnosticos')}
              className={`flex-1 px-3 py-2 text-xs font-medium transition ${
                aba === 'diagnosticos'
                  ? 'border-b-2 border-purple-600 text-purple-700'
                  : 'text-zinc-500 hover:text-zinc-700'
              }`}
            >
              🔍 Diagnósticos
              {diagnosticos.length > 0 && (
                <span className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[9px] text-white">
                  {diagnosticos.length}
                </span>
              )}
            </button>
            <button
              onClick={() => setAba('chat')}
              className={`flex-1 px-3 py-2 text-xs font-medium transition ${
                aba === 'chat'
                  ? 'border-b-2 border-purple-600 text-purple-700'
                  : 'text-zinc-500 hover:text-zinc-700'
              }`}
            >
              💬 Conversar
            </button>
          </div>

          {/* Aba Diagnósticos */}
          {aba === 'diagnosticos' && (
            <div className="flex-1 overflow-y-auto bg-zinc-50 px-3 py-3">
              <div className="mb-3 flex gap-2">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-purple-600 text-white">
                  <ClaudioAvatar size={18} />
                </div>
                <div className="max-w-[80%] rounded-2xl rounded-tl-sm bg-white p-3 text-xs text-zinc-900 shadow-sm">
                  {carregando ? (
                    <p>Analisando a licitação… 🔍</p>
                  ) : diagnosticos.length === 0 ? (
                    <p>Tudo certo por aqui! ✓<br />Não detectei problemas pendentes.</p>
                  ) : (
                    <p>
                      Detectei <strong>{diagnosticos.length}</strong>{' '}
                      {diagnosticos.length === 1 ? 'pendência' : 'pendências'}
                      {totalErros > 0 && <> ({totalErros} {totalErros === 1 ? 'crítica' : 'críticas'})</>}.
                      Click no botão roxo dos que eu sei resolver — aplico na hora.
                    </p>
                  )}
                </div>
              </div>

              {erro && <div className="mb-3 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800">❌ {erro}</div>}
              {sucesso && <div className="mb-3 rounded-md border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-800">✓ {sucesso}</div>}

              <div className="space-y-2">
                {diagnosticos.map((d) => {
                  const sev = SEV_STYLES[d.severidade];
                  const autofix = AUTO_FIX_DISPONIVEL[d.tipo];
                  return (
                    <div key={d.id} className={`rounded-lg border bg-white p-3 text-xs shadow-sm ring-2 ${sev.ring}`}>
                      <div className="flex items-start gap-2">
                        <span className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${sev.dot}`} />
                        <div className="min-w-0 flex-1">
                          <p className="font-semibold text-zinc-900">{d.titulo}</p>
                          {d.mensagem && <p className="mt-1 text-[11px] text-zinc-900">{d.mensagem}</p>}
                          {d.sugestao && <p className="mt-1.5 rounded bg-zinc-50 p-1.5 text-[11px] text-zinc-900">💡 {d.sugestao}</p>}
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-zinc-100 pt-2">
                        {autofix && (
                          <button
                            onClick={() => handleAutoFix(d)}
                            disabled={isPending}
                            className="rounded bg-purple-600 px-2 py-1 text-[10px] font-medium text-white hover:bg-purple-700 disabled:opacity-50"
                            title={autofix.descricao}
                          >
                            {autofix.label}
                          </button>
                        )}
                        {(d.acao_acionavel?.tipo === 'definir_data_base_inline' ||
                          d.acao_acionavel?.tipo === 'mapping_inline') && (
                          <button
                            onClick={() => setFormAberto((prev) => ({ ...prev, [d.id]: !prev[d.id] }))}
                            disabled={isPending}
                            className="rounded bg-purple-600 px-2 py-1 text-[10px] font-medium text-white hover:bg-purple-700 disabled:opacity-50"
                          >
                            {formAberto[d.id] ? '✕ Fechar' : d.acao_acionavel.label}
                          </button>
                        )}
                        {d.acao_acionavel?.tipo === 'abrir_mapeamentos' && (
                          <Link
                            href="/dashboard/code-mappings"
                            className="rounded border border-purple-300 bg-white px-2 py-1 text-[10px] font-medium text-purple-700 hover:bg-purple-50"
                          >
                            {d.acao_acionavel.label}
                          </Link>
                        )}
                        <button
                          onClick={() => handleResolver(d, true)}
                          disabled={isPending}
                          className="rounded border border-emerald-300 bg-white px-2 py-1 text-[10px] font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                          title="Aprende esse padrão pra editais futuros"
                        >
                          ✓ Resolvi
                        </button>
                        <button
                          onClick={() => handleIgnorar(d)}
                          disabled={isPending}
                          className="rounded border border-zinc-300 bg-white px-2 py-1 text-[10px] text-zinc-600 hover:bg-zinc-50 disabled:opacity-50"
                        >
                          Ignorar
                        </button>
                      </div>

                      {/* Inline form: definir data-base */}
                      {formAberto[d.id] && d.acao_acionavel?.tipo === 'definir_data_base_inline' && (
                        <div className="mt-2 rounded-md border border-purple-200 bg-purple-50 p-2">
                          <label className="block text-[10px] font-medium text-purple-900">
                            Data-base do edital
                          </label>
                          <p className="mt-0.5 text-[10px] text-zinc-700">
                            Formato: <code>MM/AAAA</code> (ex: <code>04/2026</code>) ou <code>mês/ano</code> (ex: <code>abril/2026</code>).
                            Olha a capa do edital — costuma estar como &quot;SINAPI MM/AAAA&quot;.
                          </p>
                          <div className="mt-1.5 flex gap-1.5">
                            <input
                              type="text"
                              autoFocus
                              value={dataBaseInput[d.id] ?? ''}
                              onChange={(e) => setDataBaseInput((prev) => ({ ...prev, [d.id]: e.target.value }))}
                              onKeyDown={(e) => { if (e.key === 'Enter') handleDefinirDataBase(d); }}
                              placeholder="04/2026"
                              className="flex-1 rounded border border-purple-300 bg-white px-2 py-1 text-xs text-zinc-900 focus:border-purple-500 focus:outline-none"
                            />
                            <button
                              onClick={() => handleDefinirDataBase(d)}
                              disabled={isPending}
                              className="rounded bg-purple-600 px-2 py-1 text-[10px] font-medium text-white hover:bg-purple-700 disabled:opacity-50"
                            >
                              Salvar
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Inline form: mapear codes descontinuados */}
                      {formAberto[d.id] && d.acao_acionavel?.tipo === 'mapping_inline' && (
                        <div className="mt-2 rounded-md border border-purple-200 bg-purple-50 p-2">
                          <p className="text-[10px] font-medium text-purple-900">
                            Mapeia code antigo → moderno
                          </p>
                          <p className="mt-0.5 text-[10px] text-zinc-700">
                            Pra cada code que falhou, digita o equivalente moderno no banco.
                            Deixa em branco os que não souber. Mesmo code (identity) sinaliza &quot;válido — retentar&quot;.
                          </p>
                          <div className="mt-1.5 space-y-1">
                            {((d.acao_acionavel.params?.codes as Array<{ fonte_original: string; codigo_original: string; descricao?: string | null }> | undefined) ?? []).map((c) => {
                              const key = `${c.fonte_original}/${c.codigo_original}`;
                              return (
                                <div key={key} className="flex items-center gap-1.5">
                                  <code className="shrink-0 rounded bg-white px-1 py-0.5 text-[10px] text-purple-900" title={c.descricao ?? ''}>
                                    {c.fonte_original}/{c.codigo_original}
                                  </code>
                                  <span className="text-[10px] text-zinc-500">→</span>
                                  <input
                                    type="text"
                                    value={(mappingInput[d.id]?.[key]) ?? ''}
                                    onChange={(e) => setMappingInput((prev) => ({
                                      ...prev,
                                      [d.id]: { ...(prev[d.id] ?? {}), [key]: e.target.value },
                                    }))}
                                    placeholder="código novo"
                                    className="flex-1 rounded border border-purple-300 bg-white px-1.5 py-0.5 text-[10px] text-zinc-900 focus:border-purple-500 focus:outline-none"
                                  />
                                </div>
                              );
                            })}
                          </div>
                          <div className="mt-1.5 flex gap-1.5">
                            <button
                              onClick={() => handleSalvarMapeamentos(d)}
                              disabled={isPending}
                              className="rounded bg-purple-600 px-2 py-1 text-[10px] font-medium text-white hover:bg-purple-700 disabled:opacity-50"
                            >
                              Salvar todos
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Aba Chat */}
          {aba === 'chat' && (
            <>
              <div className="flex-1 overflow-y-auto bg-zinc-50 px-3 py-3">
                {historico.length === 0 && (
                  <div className="mb-3 flex gap-2">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-purple-600 text-white">
                      <ClaudioAvatar size={18} />
                    </div>
                    <div className="max-w-[80%] rounded-2xl rounded-tl-sm bg-white p-3 text-xs text-zinc-900 shadow-sm">
                      <p>
                        Pode mandar a pergunta! 🤖<br />
                        Exemplos:<br />
                        • &quot;Por que o total está abaixo do edital?&quot;<br />
                        • &quot;Resolve esses codes adaptados pra mim&quot;<br />
                        • &quot;Sugere code SINAPI moderno pra TUBO ACO GALVANIZADO DN 2&quot;<br />
                        • &quot;Quais bancos estão configurados?&quot;
                      </p>
                    </div>
                  </div>
                )}

                {historico.map((m, i) => (
                  <div key={i} className={`mb-3 flex gap-2 ${m.role === 'user' ? 'flex-row-reverse' : ''}`}>
                    {m.role === 'assistant' && (
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-purple-600 text-white">
                        <ClaudioAvatar size={18} />
                      </div>
                    )}
                    <div
                      className={`max-w-[80%] whitespace-pre-wrap rounded-2xl p-3 text-xs shadow-sm ${
                        m.role === 'user'
                          ? 'rounded-tr-sm bg-purple-600 text-white'
                          : 'rounded-tl-sm bg-white text-zinc-900'
                      }`}
                    >
                      {m.content}
                    </div>
                  </div>
                ))}

                {chatPensando && (
                  <div className="mb-3 flex gap-2">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-purple-600 text-white">
                      <ClaudioAvatar size={18} />
                    </div>
                    <div className="rounded-2xl rounded-tl-sm bg-white p-3 text-xs text-zinc-500 shadow-sm">
                      <span className="inline-flex gap-1">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-purple-400" />
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-purple-400" style={{ animationDelay: '0.2s' }} />
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-purple-400" style={{ animationDelay: '0.4s' }} />
                      </span>
                      <span className="ml-2">Cláudio está pensando…</span>
                    </div>
                  </div>
                )}

                {erro && <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800">❌ {erro}</div>}

                <div ref={chatBottomRef} />
              </div>

              {/* Input */}
              <div className="border-t border-zinc-200 bg-white p-2">
                <div className="flex gap-2">
                  <textarea
                    value={perguntaAtual}
                    onChange={(e) => setPerguntaAtual(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        enviarPergunta();
                      }
                    }}
                    placeholder="Pergunte pro Cláudio… (Enter envia, Shift+Enter quebra linha)"
                    disabled={chatPensando}
                    rows={2}
                    className="flex-1 resize-none rounded border border-zinc-300 px-2 py-1.5 text-xs focus:border-purple-500 focus:outline-none disabled:bg-zinc-50"
                  />
                  <button
                    onClick={enviarPergunta}
                    disabled={chatPensando || !perguntaAtual.trim()}
                    className="rounded bg-purple-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-purple-700 disabled:opacity-50"
                  >
                    Enviar
                  </button>
                </div>
              </div>
            </>
          )}

          <footer className="border-t border-zinc-200 bg-white px-3 py-2 text-[10px] text-zinc-500">
            🔒 Cláudio atua só nesta licitação. Quando você marca &quot;Resolvi&quot;, ele aprende.
          </footer>
        </aside>
      )}
    </>
  );
}
