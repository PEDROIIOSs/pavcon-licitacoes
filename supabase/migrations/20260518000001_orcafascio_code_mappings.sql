-- =============================================================================
-- Migration: orcafascio_code_mappings
-- =============================================================================
-- Mapeamento de códigos descontinuados/inexistentes no Orçafascio (SINAPI,
-- SICRO, ORSE, etc) para códigos válidos atuais. Permite que o Edge Function
-- de cadastrar-edital substitua automaticamente quando re-rodar.
--
-- Auto-aprendizado: quando um sub-item falha com 500 no addItemsToComposition,
-- o Edge Function popula automaticamente fonte_original + codigo_original
-- + descrição (sem substituto ainda). O orçamentista edita pra adicionar
-- o codigo_substituto válido. Próximos editais com o mesmo código se
-- beneficiam automaticamente.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.orcafascio_code_mappings (
  id              BIGSERIAL PRIMARY KEY,
  fonte_original  TEXT NOT NULL,
  codigo_original TEXT NOT NULL,
  fonte_substituto  TEXT,
  codigo_substituto TEXT,
  descricao       TEXT,
  motivo          TEXT,
  criado_em       TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (fonte_original, codigo_original)
);

COMMENT ON TABLE public.orcafascio_code_mappings IS
  'Mapeamento de códigos descontinuados (ex: SICRO 2 antigos) → códigos atuais aceitos pelo Orçafascio. Populado automaticamente quando o Edge Function detecta 500 persistente em addItemsToComposition. O orçamentista preenche codigo_substituto pra próximos editais usarem automaticamente.';

COMMENT ON COLUMN public.orcafascio_code_mappings.fonte_original IS
  'Banco do code original (SINAPI, SICRO, ORSE, etc) — em caps';
COMMENT ON COLUMN public.orcafascio_code_mappings.codigo_original IS
  'Código que falhou (ex: E9515)';
COMMENT ON COLUMN public.orcafascio_code_mappings.fonte_substituto IS
  'Banco do code substituto. NULL = pendente, user precisa preencher';
COMMENT ON COLUMN public.orcafascio_code_mappings.codigo_substituto IS
  'Código atual válido (ex: 95417 SINAPI moderno). NULL = pendente';

-- Index pra lookup rápido por fonte + codigo
CREATE INDEX IF NOT EXISTS idx_orcafascio_code_mappings_lookup
  ON public.orcafascio_code_mappings (fonte_original, codigo_original)
  WHERE fonte_substituto IS NOT NULL;

-- RLS: admins editam, todos leem
ALTER TABLE public.orcafascio_code_mappings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS orcafascio_code_mappings_read_all ON public.orcafascio_code_mappings;
CREATE POLICY orcafascio_code_mappings_read_all
  ON public.orcafascio_code_mappings FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS orcafascio_code_mappings_admin_write ON public.orcafascio_code_mappings;
CREATE POLICY orcafascio_code_mappings_admin_write
  ON public.orcafascio_code_mappings FOR ALL
  TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

-- Trigger pra atualizar atualizado_em automaticamente
CREATE OR REPLACE FUNCTION public.update_orcafascio_code_mappings_atualizado_em()
RETURNS TRIGGER AS $$
BEGIN
  NEW.atualizado_em := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_orcafascio_code_mappings_atualizado_em ON public.orcafascio_code_mappings;
CREATE TRIGGER trg_orcafascio_code_mappings_atualizado_em
  BEFORE UPDATE ON public.orcafascio_code_mappings
  FOR EACH ROW EXECUTE FUNCTION public.update_orcafascio_code_mappings_atualizado_em();
