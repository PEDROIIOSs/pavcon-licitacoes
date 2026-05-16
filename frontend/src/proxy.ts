import { updateSession } from '@/lib/supabase/middleware';
import { NextResponse, type NextRequest } from 'next/server';

// Next.js 16 renomeou a convenção "middleware" pra "proxy".
// O arquivo precisa se chamar proxy.ts e exportar uma função `proxy`.
export async function proxy(request: NextRequest) {
  try {
    return await updateSession(request);
  } catch (err) {
    // Sem env (ou Supabase fora do ar) não derrubamos a request inteira —
    // deixa o pedido seguir e o RLS no Postgres continua protegendo dados.
    console.error('[proxy] falha em updateSession:', err);
    return NextResponse.next({ request });
  }
}

export const config = {
  matcher: [
    // Tudo, menos arquivos estáticos E o health check (precisa responder
    // mesmo quando o proxy falhar por falta de env).
    '/((?!_next/static|_next/image|favicon.ico|api/health|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
