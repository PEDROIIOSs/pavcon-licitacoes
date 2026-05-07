// Stub: tela de upload de novo edital. Vai virar uma das próximas etapas
// (item 5 do roadmap). Por ora só placeholder pra fechar o link do dashboard.

import Link from 'next/link';

export default function NovaLicitacaoPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <Link href="/dashboard" className="text-sm text-zinc-500 hover:text-zinc-900">
        ← voltar
      </Link>
      <h1 className="mt-4 text-2xl font-semibold text-zinc-900">Nova licitação</h1>
      <p className="mt-2 text-sm text-zinc-500">
        Upload de PDF + extração via Gemini. <strong>Em construção</strong> — próxima etapa.
      </p>
      <div className="mt-6 rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-sm text-zinc-500">
        Quando finalizado, esta tela vai:
        <ul className="mt-3 list-disc pl-5 text-xs">
          <li>Aceitar drag-and-drop do PDF do edital</li>
          <li>Subir pra <code className="rounded bg-zinc-100 px-1">storage/editais/</code></li>
          <li>Criar a licitação em status <code>aguardando_extracao</code></li>
          <li>Disparar a Edge Function <code>extracao-edital</code></li>
          <li>Redirecionar pra <code>/licitacoes/[id]</code> com progresso</li>
        </ul>
      </div>
    </main>
  );
}
