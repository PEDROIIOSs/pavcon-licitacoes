import { redirect } from 'next/navigation';

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ code?: string; error?: string }>;
}) {
  const params = await searchParams;

  // Magic link às vezes redireciona pro / em vez de /auth/callback —
  // captura o code aqui e encaminha pra completar o login.
  if (params.code) {
    redirect(`/auth/callback?code=${encodeURIComponent(params.code)}`);
  }

  redirect('/dashboard');
}
