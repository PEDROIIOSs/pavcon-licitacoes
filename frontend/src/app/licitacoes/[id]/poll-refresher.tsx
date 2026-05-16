'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Recarrega os dados do server component a cada 4s usando router.refresh().
// IMPORTANTE: substitui o antigo <meta http-equiv="refresh">, que travava
// a navegação "Voltar" do navegador (bfcache + meta refresh = loop).
// Aqui o intervalo é desmontado automaticamente quando o usuário sai da
// página, então não puxa o usuário de volta.
export function PollRefresher({ intervalMs = 4000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const id = setInterval(() => {
      router.refresh();
    }, intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);

  return null;
}
