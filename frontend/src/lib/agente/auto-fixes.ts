'use server';

// =============================================================================
// Auto-fixes do Cláudio
// =============================================================================
// Cada auto-fix é uma server action que aplica uma correção determinística
// em uma licitação. O Cláudio sugere e executa em 1-click.
//
// Padrão de retorno: { ok, mensagem, mudancas: number }
// =============================================================================

import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

interface AutoFixResult {
  ok?: boolean;
  error?: string;
  mensagem?: string;
  mudancas?: number;
}

// Reusa o mesmo detector usado no importarExtracaoManual pra manter
// consistência (se mudarmos um, o outro também muda).
function ehCodigoAdaptado(fonte: string | null, codigo: string | null): { adaptado: boolean; motivo?: string } {
  if (!codigo || !fonte) return { adaptado: false };
  const f = fonte.toUpperCase();
  if (f === 'PROPRIA' || f === 'OUTRA') return { adaptado: false };
  const c = codigo.toUpperCase().trim();
  if (/^COMPOSI[CÇ][ÃA]O\s*[\d_-]+/i.test(c)) {
    return { adaptado: true, motivo: 'código é texto literal "COMPOSIÇÃO XX"' };
  }
  if (/[\s-]ADAPT?(?:AD[OA])?\s*$|^ADAPTAD[OA]\s|\sADAP\s|\s-\s*A\s*$|-A$|-ADAP$/i.test(c)) {
    return { adaptado: true, motivo: 'sufixo de adaptação (-ADAP, -A, adaptado)' };
  }
  return { adaptado: false };
}

/**
 * AUTO-FIX 1: Reclassifica retroativamente codes adaptados como PROPRIA.
 *
 * Aplica em composicoes_extraidas existentes sem precisar re-importar JSON.
 * Útil pra licitações que foram importadas antes do fix de normalização
 * automática. O Cláudio detecta esses casos e oferece o botão pra resolver
 * em 1-click.
 *
 * Side effects:
 *   - Atualiza fonte='PROPRIA' nas linhas afetadas
 *   - Salva metadata.fonte_original + codigo_original + reclassificada_motivo
 *   - NÃO toca em orcafascio_composition_id (pra que cadastrar-edital
 *     trate como composição nova e crie no MyBase em branco)
 */
export async function reclassificarCodesAdaptados(licitacaoId: string): Promise<AutoFixResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Não autenticado.' };

  const admin = createAdminClient();
  const { data: items, error } = await admin
    .from('composicoes_extraidas')
    .select('id, fonte, codigo, metadata')
    .eq('licitacao_id', licitacaoId)
    .eq('tipo_linha', 'servico');
  if (error) return { error: error.message };

  const aReclassificar = (items ?? [])
    .map((it) => {
      const check = ehCodigoAdaptado(it.fonte, it.codigo);
      return check.adaptado ? { id: it.id, codigo: it.codigo, fonte: it.fonte, motivo: check.motivo, metadata: it.metadata } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  if (aReclassificar.length === 0) {
    return { ok: true, mensagem: 'Nada a reclassificar — todos os codes já estão corretos.', mudancas: 0 };
  }

  // Atualiza em lote
  for (const item of aReclassificar) {
    const metaAtual = (item.metadata as Record<string, unknown> | null) ?? {};
    await admin
      .from('composicoes_extraidas')
      .update({
        fonte: 'PROPRIA',
        // Limpa orcafascio_composition_id pra forçar recriação no MyBase
        orcafascio_composition_id: null,
        metadata: {
          ...metaAtual,
          fonte_original: item.fonte,
          codigo_original: item.codigo,
          reclassificada_motivo: item.motivo,
          reclassificada_em: new Date().toISOString(),
          reclassificada_por: 'claudio_auto',
        },
      })
      .eq('id', item.id);
  }

  revalidatePath(`/licitacoes/${licitacaoId}`);
  return {
    ok: true,
    mensagem: `${aReclassificar.length} item(ns) reclassificado(s) de SINAPI/ORSE pra PROPRIA. ` +
      `Próximo passo: clique "🚀 Cadastrar tudo no Orçafascio" pra criar as composições próprias correspondentes.`,
    mudancas: aReclassificar.length,
  };
}

/**
 * AUTO-FIX 2: Limpa orcafascio_composition_id de composições PROPRIA pra
 * forçar recriação no MyBase em retentativa. Útil quando o user mapeou
 * codes na tabela de mapeamentos e precisa re-rodar pra aplicar.
 */
export async function limparMyBaseIdsPropria(licitacaoId: string): Promise<AutoFixResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Não autenticado.' };

  const admin = createAdminClient();
  const { count } = await admin
    .from('composicoes_extraidas')
    .update({ orcafascio_composition_id: null }, { count: 'exact' })
    .eq('licitacao_id', licitacaoId)
    .eq('fonte', 'PROPRIA')
    .not('orcafascio_composition_id', 'is', null);

  revalidatePath(`/licitacoes/${licitacaoId}`);
  return {
    ok: true,
    mensagem: `${count ?? 0} composição(ões) própria(s) marcada(s) pra recriação. ` +
      `Clique "🚀 Cadastrar tudo" pra aplicar mapeamentos novos.`,
    mudancas: count ?? 0,
  };
}

/**
 * AUTO-FIX 3: Despacha por tipo de diagnóstico.
 * Cada `tipo` mapeia pra uma função específica.
 */
export async function executarAutoFix(
  licitacaoId: string,
  tipo: string,
): Promise<AutoFixResult> {
  switch (tipo) {
    case 'codes_adaptados_nao_reclassificados':
      return reclassificarCodesAdaptados(licitacaoId);
    case 'aplicar_mapeamentos_pendentes':
      return limparMyBaseIdsPropria(licitacaoId);
    default:
      return { error: `Auto-fix "${tipo}" não implementado ainda. Cláudio precisa de uma resolução manual.` };
  }
}
