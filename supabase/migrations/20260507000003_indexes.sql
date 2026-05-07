-- =============================================================================
-- PAVCON | Sistema de Automação de Licitações Públicas
-- Migration 03: Índices
-- =============================================================================
-- Índices secundários para performance. PKs e UNIQUEs já criam índice automático.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- profiles
-- -----------------------------------------------------------------------------
CREATE INDEX idx_profiles_role ON profiles(role) WHERE ativo = true;
CREATE INDEX idx_profiles_email ON profiles(lower(email));

-- -----------------------------------------------------------------------------
-- api_credentials
-- -----------------------------------------------------------------------------
CREATE INDEX idx_credentials_provider_ativa
  ON api_credentials(provider) WHERE ativo = true;

-- -----------------------------------------------------------------------------
-- orcafascio_sessoes
-- -----------------------------------------------------------------------------
-- Fundamental: o middleware busca por (credential_id, expires_at > now())
CREATE INDEX idx_sessoes_expires ON orcafascio_sessoes(expires_at);

-- -----------------------------------------------------------------------------
-- orcafascio_grupos_cache
-- -----------------------------------------------------------------------------
CREATE INDEX idx_grupos_setor_licitacao
  ON orcafascio_grupos_cache(is_setor_licitacao) WHERE is_setor_licitacao = true;

-- -----------------------------------------------------------------------------
-- orcafascio_orcamentos_cache
-- -----------------------------------------------------------------------------
CREATE INDEX idx_orc_cache_grupo ON orcafascio_orcamentos_cache(grupo_id);
CREATE INDEX idx_orc_cache_data ON orcafascio_orcamentos_cache(data_criacao_orcafascio DESC);
-- Índice HNSW para busca por similaridade semântica (cosine distance)
-- HNSW > IVFFlat para datasets pequenos/médios (< 100k registros) e leituras frequentes
CREATE INDEX idx_orc_cache_embedding ON orcafascio_orcamentos_cache
  USING hnsw (embedding_objeto vector_cosine_ops);

-- -----------------------------------------------------------------------------
-- composicoes_edital_sincronizadas
-- -----------------------------------------------------------------------------
-- Hash já é UNIQUE. Index para busca por descrição (trigram) ajuda em fallback fuzzy.
CREATE INDEX idx_comp_sinc_descricao_trgm
  ON composicoes_edital_sincronizadas USING gin (descricao gin_trgm_ops);
CREATE INDEX idx_comp_sinc_ultimo_uso
  ON composicoes_edital_sincronizadas(ultima_utilizacao_em DESC);

-- -----------------------------------------------------------------------------
-- licitacoes
-- -----------------------------------------------------------------------------
-- Filtros mais comuns no painel
CREATE INDEX idx_licitacoes_status ON licitacoes(status);
CREATE INDEX idx_licitacoes_criado_por ON licitacoes(criado_por);
CREATE INDEX idx_licitacoes_status_criado
  ON licitacoes(status, created_at DESC);
-- Busca textual por título e órgão
CREATE INDEX idx_licitacoes_titulo_trgm
  ON licitacoes USING gin (titulo gin_trgm_ops);
CREATE INDEX idx_licitacoes_orgao_trgm
  ON licitacoes USING gin (orgao_licitante gin_trgm_ops);
-- Filtro temporal (data de abertura próxima)
CREATE INDEX idx_licitacoes_data_abertura
  ON licitacoes(data_abertura) WHERE status NOT IN ('finalizado', 'arquivada');

-- -----------------------------------------------------------------------------
-- licitacao_arquivos
-- -----------------------------------------------------------------------------
CREATE INDEX idx_arquivos_licitacao ON licitacao_arquivos(licitacao_id);
-- Detectar reupload (idempotência)
CREATE INDEX idx_arquivos_hash ON licitacao_arquivos(hash_sha256) WHERE hash_sha256 IS NOT NULL;

-- -----------------------------------------------------------------------------
-- extracoes_ocr
-- -----------------------------------------------------------------------------
CREATE INDEX idx_extracoes_licitacao_status
  ON extracoes_ocr(licitacao_id, status);
CREATE INDEX idx_extracoes_pendentes
  ON extracoes_ocr(created_at) WHERE status IN ('pendente', 'processando');

-- -----------------------------------------------------------------------------
-- composicoes_extraidas
-- -----------------------------------------------------------------------------
CREATE INDEX idx_comp_extr_licitacao ON composicoes_extraidas(licitacao_id, ordem);
CREATE INDEX idx_comp_extr_codigo ON composicoes_extraidas(codigo, fonte);
CREATE INDEX idx_comp_extr_propria
  ON composicoes_extraidas(licitacao_id) WHERE fonte = 'PROPRIA';

-- -----------------------------------------------------------------------------
-- composicao_propria_itens
-- -----------------------------------------------------------------------------
CREATE INDEX idx_propria_itens_comp ON composicao_propria_itens(composicao_extraida_id, ordem);

-- -----------------------------------------------------------------------------
-- analises_historicas
-- -----------------------------------------------------------------------------
CREATE INDEX idx_analises_licitacao_score
  ON analises_historicas(licitacao_id, similaridade_score DESC);

-- -----------------------------------------------------------------------------
-- notificacoes
-- -----------------------------------------------------------------------------
CREATE INDEX idx_notif_user_nao_lidas
  ON notificacoes(user_id, created_at DESC) WHERE lida = false;

-- -----------------------------------------------------------------------------
-- audit_log_integracoes
-- -----------------------------------------------------------------------------
CREATE INDEX idx_audit_licitacao_data
  ON audit_log_integracoes(licitacao_id, created_at DESC);
CREATE INDEX idx_audit_user_data
  ON audit_log_integracoes(user_id, created_at DESC);
CREATE INDEX idx_audit_provider_data
  ON audit_log_integracoes(provider, created_at DESC);
CREATE INDEX idx_audit_trace ON audit_log_integracoes(trace_id) WHERE trace_id IS NOT NULL;
