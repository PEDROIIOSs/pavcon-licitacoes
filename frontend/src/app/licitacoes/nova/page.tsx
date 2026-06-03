import Link from 'next/link';
import { UploadForm } from './upload-form';

export const metadata = { title: 'Novo orçamento — OrçaPav AI' };

export default function NovaLicitacaoPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-8">
      <Link href="/dashboard" className="text-sm text-zinc-500 hover:text-zinc-900">
        ← voltar
      </Link>
      <h1 className="mt-4 text-2xl font-semibold text-zinc-900">Novo orçamento</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Suba os PDFs do órgão (planilha orçamentária, composições, BDI, leis sociais…).
        Depois você dispara a extração na próxima tela.
      </p>

      <div className="mt-8">
        <UploadForm />
      </div>
    </main>
  );
}
