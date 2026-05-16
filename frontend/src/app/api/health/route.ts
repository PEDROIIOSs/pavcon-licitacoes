import { NextResponse } from 'next/server';

// Health check — confirma quais env vars estão setadas em runtime
// sem expor os valores. Útil pra debugar 500 silencioso na Vercel.

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const required = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
  ];
  const status = required.map((name) => ({
    name,
    set: Boolean(process.env[name]),
  }));
  const allSet = status.every((s) => s.set);
  return NextResponse.json(
    { ok: allSet, env: status, runtime: 'nodejs', nextVersion: '16' },
    { status: allSet ? 200 : 500 },
  );
}
