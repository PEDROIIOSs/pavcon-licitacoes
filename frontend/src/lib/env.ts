// Leitura centralizada de env vars com fail-fast e mensagem útil.
// Evita 500 silencioso (MIDDLEWARE_INVOCATION_FAILED) quando a var falta na Vercel.
//
// IMPORTANTE:
// 1. As leituras `NEXT_PUBLIC_*` precisam ser LITERAIS (`process.env.NEXT_PUBLIC_X`)
//    pra que o Next.js as inline no bundle do browser em build-time.
// 2. Todos os campos são getters (lazy). Assim, se uma var faltar, o throw acontece
//    no ponto de USO (capturável pelo try/catch do proxy), não no import do módulo
//    (que derrubaria o handler inteiro com MIDDLEWARE_INVOCATION_FAILED genérico).

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
  get NEXT_PUBLIC_SUPABASE_URL() {
    return ensure(
      'NEXT_PUBLIC_SUPABASE_URL',
      process.env.NEXT_PUBLIC_SUPABASE_URL,
    );
  },
  get NEXT_PUBLIC_SUPABASE_ANON_KEY() {
    return ensure(
      'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    );
  },
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
