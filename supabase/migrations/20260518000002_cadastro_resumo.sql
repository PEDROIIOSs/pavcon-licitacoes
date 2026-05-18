-- =============================================================================
-- Migration: cadastro_resumo
-- =============================================================================
-- Adiciona campo JSONB pra armazenar o resumo do último cadastramento no
-- Orçafascio (warnings, contagens, totais, URL do orçamento). Lido pela UI
-- da licitação pra mostrar painel de diagnóstico com items pendentes,
-- divergências de total e atalho pro orçamento no Orçafascio.
-- =============================================================================

ALTER TABLE public.licitacoes
  ADD COLUMN IF NOT EXISTS cadastro_resumo JSONB;

COMMENT ON COLUMN public.licitacoes.cadastro_resumo IS
  'Resumo do último cadastramento no Orçafascio. Estrutura: {cadastrado_em, budget_id, budget_url, composicoes_criadas, total_itens_batch, bdi, leis_sociais_horista, bancos_configurados[], warnings[]}';
