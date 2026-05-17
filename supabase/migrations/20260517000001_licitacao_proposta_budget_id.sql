-- =============================================================================
-- Migration: licitacao_proposta_budget_id
-- =============================================================================
-- Adiciona orcafascio_proposta_budget_id pra rastrear o orçamento da PROPOSTA
-- readequada (2ª versão no Orçafascio com BDI reduzido por desconto linear).
--
-- Colunas relacionadas (já existentes):
--   - desconto_percentual: % de desconto linear aplicado
--   - valor_proposta_pavcon: valor total do orçamento com desconto
-- =============================================================================

ALTER TABLE public.licitacoes
  ADD COLUMN IF NOT EXISTS orcafascio_proposta_budget_id text;

COMMENT ON COLUMN public.licitacoes.orcafascio_proposta_budget_id IS
  'ID do orçamento da PROPOSTA readequada no Orçafascio (2ª versão com BDI reduzido por desconto linear). NULL = proposta ainda não cadastrada.';
