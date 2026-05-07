import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const STATUS_LABEL: Record<string, string> = {
  rascunho: 'Rascunho',
  aguardando_extracao: 'Aguardando extração',
  extraindo: 'Extraindo…',
  extracao_concluida: 'Extração concluída',
  aguardando_revisao_humana: 'Aguarda revisão',
  criando_composicoes_edital: 'Cadastrando composições',
  criando_orcamento_base: 'Cadastrando orçamento base',
  fase1_concluida: 'Fase 1 concluída',
  definindo_estrategia: 'Definindo estratégia',
  gerando_proposta: 'Gerando proposta',
  finalizado: 'Finalizado',
  erro: 'Erro',
  arquivada: 'Arquivada',
};

const STATUS_COLOR: Record<string, string> = {
  rascunho: 'bg-zinc-200 text-zinc-700',
  aguardando_extracao: 'bg-amber-100 text-amber-800',
  extraindo: 'bg-amber-200 text-amber-900',
  extracao_concluida: 'bg-emerald-100 text-emerald-800',
  aguardando_revisao_humana: 'bg-blue-100 text-blue-800',
  criando_composicoes_edital: 'bg-amber-200 text-amber-900',
  criando_orcamento_base: 'bg-amber-200 text-amber-900',
  fase1_concluida: 'bg-emerald-200 text-emerald-900',
  definindo_estrategia: 'bg-blue-100 text-blue-800',
  gerando_proposta: 'bg-amber-200 text-amber-900',
  finalizado: 'bg-emerald-300 text-emerald-900',
  erro: 'bg-red-100 text-red-800',
  arquivada: 'bg-zinc-300 text-zinc-700',
};

export function statusLabel(status: string) {
  return STATUS_LABEL[status] ?? status;
}

export function statusColor(status: string) {
  return STATUS_COLOR[status] ?? 'bg-zinc-100 text-zinc-700';
}

export function formatBRL(value: number | null | undefined) {
  if (value == null) return '—';
  return value.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 2,
  });
}

export function formatDate(value: string | null | undefined) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('pt-BR');
}
