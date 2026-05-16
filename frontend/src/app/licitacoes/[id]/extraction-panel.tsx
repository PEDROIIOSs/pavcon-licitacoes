'use client';

import { useState, useTransition } from 'react';
import {
  approveExtraction,
  cadastrarNoOrcafascio,
  cadastrarOrcamentoCompleto,
  resetToDraft,
  saveExtractionEdits,
  startExtraction,
  type ExtractedItem,
} from './actions';
import { ExtractionEditor } from './extraction-editor';
import { ImportJsonModal } from './import-json-modal';

interface ExtractionSummary {
  id: string;
  status: string;
  created_at: string;
  concluido_em: string | null;
  llm_model: string;
  prompt_versao: string;
  tokens_input: number | null;
  tokens_output: number | null;
  custo_usd: number | null;
  duracao_ms: number | null;
  erro_detalhe: string | null;
  json: { cabecalho: Record<string, unknown>; itens: ExtractedItem[] } | null;
  ja_revisada: boolean;
}

interface Props {
  licitacaoId: string;
  arquivoId: string | null;
  status: string;
  ultimaExtracao: ExtractionSummary | null;
}

export function ExtractionPanel({ licitacaoId, arquivoId, status, ultimaExtracao }: Props) {
  const [isPending, startTransition] = useTransition();
  const [actionError, setActionError] = useState<string | null>(null);
  const [importModal, setImportModal] = useState<null | 'notebooklm' | 'claude_code'>(null);
  const [importResult, setImportResult] = useState<{ composicoes: number; subItens: number } | null>(null);
  const [cadastroResult, setCadastroResult] = useState<{
    grupo_descricao?: string;
    composicoes_criadas?: number;
    composicoes_puladas?: number;
    itens_adicionados?: number;
    warnings?: string[];
  } | null>(null);
  const [orcamentoResult, setOrcamentoResult] = useState<{
    budget_id?: string;
    budget_url?: string;
    etapas_criadas?: number;
    composicoes_criadas?: number;
    total_itens_batch?: number;
    bdi?: number;
    leis_sociais_horista?: number;
    bancos_configurados?: string[];
  } | null>(null);

  const canStart = (status === 'rascunho' || status === 'aguardando_extracao') &&
    !!arquivoId;
  const isExtracting = status === 'extraindo';
  const isReviewable = status === 'aguardando_revisao_humana' && ultimaExtracao?.json;
  const canCadastrar = status === 'criando_composicoes_edital';
  const isDone = ['fase1_concluida', 'criando_orcamento_base', 'finalizado'].includes(status);
  const isError = status === 'erro';

  function handleStart() {
    if (!arquivoId) return;
    setActionError(null);
    startTransition(async () => {
      const r = await startExtraction(licitacaoId, arquivoId);
      if (r?.error) setActionError(`${r.error}${r.details ? ': ' + JSON.stringify(r.details).slice(0, 200) : ''}`);
    });
  }

  function handleReset() {
    setActionError(null);
    startTransition(async () => {
      const r = await resetToDraft(licitacaoId);
      if (r?.error) setActionError(r.error);
    });
  }

  function handleCadastrar() {
    setActionError(null);
    setCadastroResult(null);
    startTransition(async () => {
      const r = await cadastrarNoOrcafascio(licitacaoId);
      if (r?.error) {
        setActionError(r.error);
      } else {
        setCadastroResult({
          grupo_descricao: r.grupo_descricao,
          composicoes_criadas: r.composicoes_criadas,
          composicoes_puladas: r.composicoes_puladas,
          itens_adicionados: r.itens_adicionados,
          warnings: r.warnings,
        });
      }
    });
  }

  function handleCadastrarOrcamentoCompleto() {
    setActionError(null);
    setOrcamentoResult(null);
    startTransition(async () => {
      const r = await cadastrarOrcamentoCompleto(licitacaoId);
      if (r?.error) {
        setActionError(r.error);
      } else {
        setOrcamentoResult({
          budget_id: r.budget_id,
          budget_url: r.budget_url,
          etapas_criadas: r.etapas_criadas,
          composicoes_criadas: r.composicoes_criadas,
          total_itens_batch: r.total_itens_batch,
          bdi: r.bdi,
          leis_sociais_horista: r.leis_sociais_horista,
          bancos_configurados: r.bancos_configurados,
        });
      }
    });
  }

  return (
    <section className="space-y-4 rounded-lg border border-zinc-200 bg-white p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-900">Extração do orçamento</h2>
        {ultimaExtracao && (
          <span className="text-xs text-zinc-500">
            {ultimaExtracao.llm_model} · {ultimaExtracao.prompt_versao}
          </span>
        )}
      </div>

      {actionError && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-800">{actionError}</div>
      )}

      {canStart && (
        <div className="space-y-3">
          <p className="text-xs text-zinc-600">Escolha como extrair os dados deste orçamento:</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {/* Opção 1 — Gemini API automática */}
            <button
              onClick={handleStart}
              disabled={isPending}
              className="rounded-md border border-zinc-300 bg-white p-4 text-left hover:bg-zinc-50 disabled:opacity-50"
            >
              <p className="text-sm font-semibold text-zinc-900">
                ⚡ Gemini API (automático)
              </p>
              <p className="mt-1 text-xs text-zinc-600">
                Roda a Edge Function chamando Gemini 2.5 Pro. 1–3 min, ~$0.50/edital.
              </p>
            </button>

            {/* Opção 2 — NotebookLM */}
            <button
              onClick={() => setImportModal('notebooklm')}
              disabled={isPending}
              className="rounded-md border border-zinc-300 bg-white p-4 text-left hover:bg-zinc-50 disabled:opacity-50"
            >
              <p className="text-sm font-semibold text-zinc-900">
                📓 NotebookLM (cola JSON)
              </p>
              <p className="mt-1 text-xs text-zinc-600">
                Você extrai no NotebookLM com prompt pronto, cola o JSON aqui. Free.
              </p>
            </button>

            {/* Opção 3 — Claude Code manual */}
            <button
              onClick={() => setImportModal('claude_code')}
              disabled={isPending}
              className="rounded-md border border-zinc-300 bg-white p-4 text-left hover:bg-zinc-50 disabled:opacity-50"
            >
              <p className="text-sm font-semibold text-zinc-900">
                🤖 Claude Code (cola JSON)
              </p>
              <p className="mt-1 text-xs text-zinc-600">
                Você anexa o PDF no chat do Claude, ele devolve o JSON, você cola.
              </p>
            </button>
          </div>
          {isPending && <p className="text-xs text-zinc-500">Processando…</p>}
        </div>
      )}

      {importResult && (
        <div className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-800">
          ✓ JSON importado: <strong>{importResult.composicoes}</strong> composições e{' '}
          <strong>{importResult.subItens}</strong> sub-itens inseridos.
        </div>
      )}

      <ImportJsonModal
        licitacaoId={licitacaoId}
        source={importModal ?? 'outro'}
        open={importModal !== null}
        onClose={() => setImportModal(null)}
        onSuccess={(c, s) => setImportResult({ composicoes: c, subItens: s })}
      />

      {isExtracting && (
        <div className="rounded-md bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-medium">Extração em andamento…</p>
          <p className="mt-1 text-xs">
            Pode levar 1–3 minutos pra editais grandes. A página vai recarregar
            sozinha quando terminar.
          </p>
        </div>
      )}

      {isError && (
        <div className="space-y-2">
          <p className="text-sm text-red-800">A extração falhou.</p>
          <button
            onClick={handleReset}
            disabled={isPending}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50"
          >
            Voltar pra rascunho
          </button>
        </div>
      )}

      {isReviewable && ultimaExtracao?.json && (
        <ExtractionEditor
          licitacaoId={licitacaoId}
          extracaoId={ultimaExtracao.id}
          jsonInicial={ultimaExtracao.json}
          jaRevisada={ultimaExtracao.ja_revisada}
        />
      )}

      {canCadastrar && (
        <div className="space-y-3 rounded-md border border-blue-200 bg-blue-50 p-4">
          <div>
            <p className="text-sm font-medium text-blue-900">Pronto pra cadastrar no Orçafascio</p>
            <p className="mt-1 text-xs text-blue-800">
              O bot vai criar uma pasta no seu MyBase e cadastrar todas as composições próprias do edital com seus itens.
              Depois você só precisa criar o orçamento no painel do Orçafascio importando a pasta.
            </p>
          </div>
          <button
            onClick={handleCadastrar}
            disabled={isPending}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {isPending ? 'Cadastrando…' : 'Cadastrar no Orçafascio'}
          </button>
        </div>
      )}

      {cadastroResult && (
        <div className="space-y-2 rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          <p className="font-medium">✓ Cadastrado com sucesso</p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <dt className="text-emerald-700">Pasta criada</dt>
            <dd className="font-medium">{cadastroResult.grupo_descricao ?? '—'}</dd>
            <dt className="text-emerald-700">Composições criadas</dt>
            <dd className="font-medium">{cadastroResult.composicoes_criadas ?? 0}</dd>
            <dt className="text-emerald-700">Itens adicionados</dt>
            <dd className="font-medium">{cadastroResult.itens_adicionados ?? 0}</dd>
            {(cadastroResult.composicoes_puladas ?? 0) > 0 && (
              <>
                <dt className="text-emerald-700">Já cadastradas (puladas)</dt>
                <dd className="font-medium">{cadastroResult.composicoes_puladas}</dd>
              </>
            )}
          </dl>
          {cadastroResult.warnings && cadastroResult.warnings.length > 0 && (
            <details className="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-900">
              <summary className="cursor-pointer">⚠ {cadastroResult.warnings.length} avisos</summary>
              <ul className="mt-2 list-disc pl-4">
                {cadastroResult.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </details>
          )}
          <p className="mt-2 text-xs text-emerald-800">
            <strong>Próximo passo:</strong> abra o Orçafascio, crie um novo Orçamento apontando pra pasta criada e importe as composições.
          </p>
        </div>
      )}

      {/* Cadastrar orçamento completo — disponível após cadastrar composições (fase1_concluida) */}
      {(status === 'fase1_concluida' || status === 'criando_orcamento_base') && !orcamentoResult && (
        <div className="space-y-3 rounded-md border border-purple-200 bg-purple-50 p-4">
          <div>
            <p className="text-sm font-medium text-purple-900">
              🚀 Cadastrar orçamento completo no Orçafascio (automação 100%)
            </p>
            <p className="mt-1 text-xs text-purple-800">
              Cria o orçamento no Orçafascio com cabeçalho, BDI, leis sociais e adiciona
              todas as etapas + composições em batch único. Usa a API interna /v2023/
              (cookie de sessão). Você só precisa abrir o link no fim pra revisar.
            </p>
          </div>
          <button
            onClick={handleCadastrarOrcamentoCompleto}
            disabled={isPending}
            className="rounded-md bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50"
          >
            {isPending ? 'Cadastrando…' : '🚀 Cadastrar orçamento completo'}
          </button>
        </div>
      )}

      {orcamentoResult && (
        <div className="space-y-2 rounded-md border border-emerald-300 bg-emerald-50 p-4 text-sm">
          <p className="font-semibold text-emerald-900">
            ✅ Orçamento criado no Orçafascio!
          </p>
          {orcamentoResult.budget_url && (
            <a
              href={orcamentoResult.budget_url}
              target="_blank"
              rel="noreferrer"
              className="block rounded-md bg-white px-3 py-2 text-xs text-emerald-800 underline hover:bg-emerald-100"
            >
              {orcamentoResult.budget_url}
            </a>
          )}
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-emerald-800">
            <dt>Budget ID:</dt>
            <dd className="font-mono">{orcamentoResult.budget_id}</dd>
            <dt>Etapas criadas:</dt>
            <dd className="font-medium">{orcamentoResult.etapas_criadas ?? 0}</dd>
            <dt>Composições criadas:</dt>
            <dd className="font-medium">{orcamentoResult.composicoes_criadas ?? 0}</dd>
            <dt>BDI configurado:</dt>
            <dd className="font-medium">{orcamentoResult.bdi}%</dd>
            <dt>Leis sociais (horista):</dt>
            <dd className="font-medium">{orcamentoResult.leis_sociais_horista}%</dd>
            {orcamentoResult.bancos_configurados && orcamentoResult.bancos_configurados.length > 0 && (
              <>
                <dt>Bancos:</dt>
                <dd className="font-medium">{orcamentoResult.bancos_configurados.join(', ')}</dd>
              </>
            )}
          </dl>
          <p className="mt-3 text-xs text-emerald-700">
            <strong>Próximo passo:</strong> abra o link acima no navegador (precisa estar
            logado no Orçafascio) pra revisar o orçamento criado.
          </p>
        </div>
      )}

      {isDone && ultimaExtracao?.json && (
        <div className="space-y-2 text-sm">
          <p className="text-emerald-700">Extração aprovada e composições cadastradas no Orçafascio.</p>
          <details className="text-xs">
            <summary className="cursor-pointer text-zinc-600">Ver itens extraídos ({ultimaExtracao.json.itens.length})</summary>
            <pre className="mt-2 max-h-96 overflow-auto rounded bg-zinc-50 p-3 text-[11px]">
              {JSON.stringify(ultimaExtracao.json, null, 2)}
            </pre>
          </details>
        </div>
      )}

      {!ultimaExtracao && !canStart && !isExtracting && (
        <p className="text-sm text-zinc-500">
          Suba um PDF antes de iniciar a extração.
        </p>
      )}
    </section>
  );
}

// helper para o server-side aproveitar
export async function _approve(licitacaoId: string) {
  return await approveExtraction(licitacaoId);
}
export async function _save(
  licitacaoId: string,
  extracaoId: string,
  json: { cabecalho: Record<string, unknown>; itens: ExtractedItem[] },
) {
  return await saveExtractionEdits(licitacaoId, extracaoId, json);
}
