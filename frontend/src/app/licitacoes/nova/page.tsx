import Link from 'next/link';
import { UploadForm } from './upload-form';

export const metadata = { title: 'Novo orçamento — OrçaPav AI' };

export default function NovaLicitacaoPage() {
  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="h-1 w-full bg-gradient-to-r from-pavcon-navy via-pavcon-navy-light to-pavcon-orange" />
      <main className="mx-auto max-w-3xl px-6 py-8">
        <Link href="/dashboard" className="inline-flex items-center gap-1 text-sm font-medium text-pavcon-navy hover:text-pavcon-navy-dark">
          ← voltar
        </Link>
        <h1 className="mt-4 text-2xl font-bold tracking-tight text-pavcon-coal">Novo orçamento</h1>
        <p className="mt-1 text-sm text-zinc-600">
          Suba os PDFs do órgão (planilha orçamentária, composições, BDI, leis sociais…).
          Depois você dispara a extração na próxima tela.
        </p>

        <div className="mt-8 rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
          <UploadForm />
        </div>
      </main>
    </div>
  );
}
