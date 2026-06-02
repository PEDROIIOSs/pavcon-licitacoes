-- =============================================================================
-- Migration: agente de suporte (diagnósticos + padrões aprendidos)
-- =============================================================================
-- Agente plugado no sistema que:
--   1. Analisa cada licitação procurando padrões de erro conhecidos
--   2. Sugere correção (acionável via 1-click pra o user)
--   3. Auto-aprende: quando o orçamentista resolve um diagnóstico, o
--      padrão é memorizado e aplicado automaticamente em editais futuros
--
-- Padrões suportados inicialmente (vide lib/agente/detectores.ts):
--   - codes_descontinuados: sub-itens com 500 silencioso
--   - composicao_vazia: PROPRIA sem detalhamento no JSON
--   - data_base_fallback: parser caiu no fallback "mês passado"
--   - banco_uf_fixa: SEDOP/SETOP/etc com UF do edital (ignora regra do banco)
--   - cadastro_incompleto: status fase1_concluida mas cadastro_resumo NULL
--   - chunking_macros_perdidos: orçamentos > 300 items dividem em chunks
--   - codes_legacy_curtos: SINAPI ≤4 dígitos (alta probabilidade de erro)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.agente_diagnosticos (
  id              BIGSERIAL PRIMARY KEY,
  licitacao_id    UUID NOT NULL REFERENCES public.licitacoes(id) ON DELETE CASCADE,
  tipo            TEXT NOT NULL,
  severidade      TEXT NOT NULL CHECK (severidade IN ('info','aviso','erro','sucesso')),
  titulo          TEXT NOT NULL,
  mensagem        TEXT,
  sugestao        TEXT,
  acao_acionavel  JSONB,  -- {tipo: 'aplicar_mapeamento', params: {...}}
  status          TEXT NOT NULL DEFAULT 'pendente'
                  CHECK (status IN ('pendente','aplicado','resolvido_manualmente','ignorado')),
  contexto        JSONB,  -- snapshot do estado quando detectado
  detectado_em    TIMESTAMPTZ DEFAULT NOW(),
  resolvido_em    TIMESTAMPTZ,
  resolvido_por   UUID REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS idx_agente_diagnosticos_licitacao_status
  ON public.agente_diagnosticos (licitacao_id, status);

CREATE TABLE IF NOT EXISTS public.agente_padroes_aprendidos (
  id                 BIGSERIAL PRIMARY KEY,
  tipo_diagnostico   TEXT NOT NULL,
  padrao_match       JSONB NOT NULL,
  solucao_aplicar    JSONB NOT NULL,
  descricao          TEXT,
  vezes_aplicado     INTEGER DEFAULT 0,
  criado_por         UUID REFERENCES auth.users(id),
  criado_em          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tipo_diagnostico, padrao_match)
);

COMMENT ON TABLE public.agente_diagnosticos IS
  'Diagnósticos do agente de suporte por licitação. Cada erro detectado vira uma row com sugestão acionável.';
COMMENT ON TABLE public.agente_padroes_aprendidos IS
  'Padrões aprendidos quando o orçamentista resolve um diagnóstico. Aplicados automaticamente em editais futuros.';

ALTER TABLE public.agente_diagnosticos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agente_padroes_aprendidos ENABLE ROW LEVEL SECURITY;

CREATE POLICY agente_read_authenticated ON public.agente_diagnosticos
  FOR SELECT TO authenticated USING (true);
CREATE POLICY agente_write_admin ON public.agente_diagnosticos
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY padroes_read_authenticated ON public.agente_padroes_aprendidos
  FOR SELECT TO authenticated USING (true);
CREATE POLICY padroes_write_admin ON public.agente_padroes_aprendidos
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
