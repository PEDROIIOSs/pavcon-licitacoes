import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Pavcon Licitações',
  description: 'Automação de orçamentos para licitações públicas',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body className="bg-zinc-50 text-zinc-900 antialiased">{children}</body>
    </html>
  );
}
