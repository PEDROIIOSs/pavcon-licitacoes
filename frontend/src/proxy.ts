import { updateSession } from '@/lib/supabase/middleware';
import type { NextRequest } from 'next/server';

// Next.js 16 renomeou a convenção "middleware" pra "proxy".
// O arquivo precisa se chamar proxy.ts e exportar uma função `proxy`.
export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    // Tudo, menos arquivos estáticos
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
