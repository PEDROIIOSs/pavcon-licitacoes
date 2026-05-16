// Leitura centralizada de env vars com fail-fast e mensagem útil.
// Evita 500 silencioso (MIDDLEWARE_INVOCATION_FAILED) quando a var falta na Vercel.
//
// IMPORTANTE: as leituras `NEXT_PUBLIC_*` precisam ser LITERAIS
// (`process.env.NEXT_PUBLIC_X`) pra que o Next.js as inline no bundle do
// browser em build-time. Acesso dinâmico (`process.env[name]`) NÃO é inline.

function ensure(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `[env] ${name} não está definida. ` +
        `Em local: adicione em frontend/.env.local. ` +
        `Em produção: configure em https://vercel.com/dashboard → Project → Settings → Environment Variables.`,
    );
  }
  return value;
}

export const env = {
  NEXT_PUBLIC_SUPABASE_URL: ensure(
    'NEXT_PUBLIC_SUPABASE_URL',
    process.env.NEXT_PUBLIC_SUPABASE_URL,
  ),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: ensure(
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  ),
  // Server-only — getter lazy pra não quebrar bundle em código client que
  // importe `env` por engano (o valor só é lido quando alguém acessa).
  get SUPABASE_SERVICE_ROLE_KEY() {
    return ensure(
      'SUPABASE_SERVICE_ROLE_KEY',
      process.env.SUPABASE_SERVICE_ROLE_KEY,
    );
  },
  get NEXT_PUBLIC_SITE_URL() {
    return process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
  },
};
