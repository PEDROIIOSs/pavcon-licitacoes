-- =============================================================================
-- PAVCON | Sistema de Automação de Licitações Públicas
-- Migration 02: Tabelas
-- =============================================================================
-- Cria todas as tabelas do domínio na ordem correta (respeitando FKs).
-- Não inclui RLS, índices secundários, triggers - estão em migrations seguintes.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. PROFILES (estende auth.users do Supabase)
-- -----------------------------------------------------------------------------
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  nome_completo TEXT NOT NULL,
  email TEXT NOT NULL,
  role user_role NOT NULL DEFAULT 'orcamentista',
  ativo BOOLEAN NOT NULL DEFAULT true,
  ultimo_login_em TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE profiles IS 'Perfis dos usuários internos da Pavcon. PK referencia auth.users.';

-- -----------------------------------------------------------------------------
-- 2. API_CREDENTIALS (referência para Supabase Vault)
-- -----------------------------------------------------------------------------
-- Os tokens em si NUNCA ficam aqui. Eles ficam no Vault (vault.secrets).
-- Esta tabela só guarda o ponteiro (vault_secret_id) e metadados não-sensíveis.
CREATE TABLE api_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  escopo TEXT NOT NULL CHECK (escopo IN ('pessoal', 'organizacional')),
  provider credential_provider NOT NULL,
  -- UUID do secret no Supabase Vault. Usar vault.create_secret() para gerar.
  vault_secret_id UUID NOT NULL,
  -- Metadados não sensíveis: nome do workspace, modelo padrão, base URL custom, etc.
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ativo BOOLEAN NOT NULL DEFAULT true,
  ultimo_uso_em TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Uma credencial ativa por (owner, provider, escopo)
  UNIQUE (owner_id, provider, escopo)
);

COMMENT ON TABLE api_credentials IS 'Ponteiros para secrets no Vault. NUNCA armazenar tokens em texto puro aqui.';
COMMENT ON COLUMN api_credentials.vault_secret_id IS 'UUID retornado por vault.create_secret(). Resolver via vault.read_secret().';

-- -----------------------------------------------------------------------------
-- 3. ORCAFASCIO_SESSOES (cache do JWT de 24h do Orçafascio)
-- -----------------------------------------------------------------------------
-- O auth_token do Orçafascio expira em 24h. Cacheamos para evitar login repetido.
-- O middleware do backend renova automaticamente quando faltar < 5min para expirar.
CREATE TABLE orcafascio_sessoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id UUID NOT NULL REFERENCES api_credentials(id) ON DELETE CASCADE,
  auth_token TEXT NOT NULL,
  orcafascio_user_id TEXT NOT NULL,
  orcafascio_company_id TEXT NOT NULL,
  orcafascio_department_id TEXT,
  email TEXT NOT NULL,
  company_name TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Uma sessão ativa por credencial
  UNIQUE (credential_id)
);

-- -----------------------------------------------------------------------------
-- 4. ORCAFASCIO_GRUPOS_CACHE
-- -----------------------------------------------------------------------------
-- Cache local dos grupos (pastas) do Orçafascio. Evita re-consulta a cada
-- listagem. O grupo "Setor de Licitação" é marcado com is_setor_licitacao=true.
CREATE TABLE orcafascio_grupos_cache (
  id TEXT PRIMARY KEY,                  -- ID original do Orçafascio (ObjectId Mongo)
  description TEXT NOT NULL,
  company_id TEXT NOT NULL,
  department_id TEXT,
  user_id TEXT,
  is_setor_licitacao BOOLEAN NOT NULL DEFAULT false,
  data_criacao_orcafascio TIMESTAMPTZ,
  sincronizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE orcafascio_grupos_cache IS 'Cache de grupos (pastas) do Orçafascio. Marcar manualmente qual é o "Setor de Licitação".';

-- -----------------------------------------------------------------------------
-- 5. ORCAFASCIO_ORCAMENTOS_CACHE (orçamentos históricos com embeddings)
-- -----------------------------------------------------------------------------
-- Cache de orçamentos finalizados em projetos anteriores (Orçafascio).
-- Usado para análise histórica e busca por similaridade semântica.
CREATE TABLE orcafascio_orcamentos_cache (
  id TEXT PRIMARY KEY,                  -- ID do orçamento no Orçafascio
  owner_id TEXT,
  department_id TEXT,
  grupo_id TEXT REFERENCES orcafascio_grupos_cache(id),
  code TEXT,
  description TEXT,
  state TEXT,
  social_charges BOOLEAN,
  exempt BOOLEAN,
  -- Conteúdo completo (vindo do relatório sintético)
  relatorio_sintetico JSONB,
  -- BDI e leis sociais aplicados (extraídos do relatório)
  bdi_aplicado NUMERIC(5, 2),
  leis_sociais NUMERIC(5, 2),
  valor_total NUMERIC(14, 2),
  -- Embedding do "objeto" para busca por similaridade
  -- 1536 = padrão OpenAI text-embedding-3-small e voyage-3
  -- Ajustar para 768 se usar Gemini embedding-001 com truncamento
  embedding_objeto vector(1536),
  data_criacao_orcafascio TIMESTAMPTZ,
  sincronizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN orcafascio_orcamentos_cache.embedding_objeto IS
  'Embedding do campo "description" para busca por similaridade. Dimensão 1536 (OpenAI/Voyage). Se mudar provedor, ajustar via ALTER TABLE.';

-- -----------------------------------------------------------------------------
-- 6. COMPOSICOES_EDITAL_SINCRONIZADAS (acervo reutilizável)
-- -----------------------------------------------------------------------------
-- Quando uma composição PRÓPRIA aparece em um edital, sincronizamos no
-- Orçafascio e guardamos a referência aqui. Se a mesma composição aparecer
-- em outro edital (detectado por hash_assinatura), reutilizamos o ID.
CREATE TABLE composicoes_edital_sincronizadas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SHA-256 da descrição normalizada + lista de insumos (em ordem canônica)
  hash_assinatura TEXT NOT NULL UNIQUE,
  descricao TEXT NOT NULL,
  unidade TEXT,
  -- IDs no Orçafascio (após sincronização)
  orcafascio_composition_id TEXT NOT NULL,
  orcafascio_codigo TEXT NOT NULL,
  -- Procedência (auditoria - de qual edital veio originalmente)
  origem_orgao TEXT,
  origem_codigo_no_edital TEXT,         -- "COMP11" no edital original
  primeira_licitacao_id UUID,           -- FK adicionada após criar licitacoes
  vezes_reutilizada INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultima_utilizacao_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE composicoes_edital_sincronizadas IS
  'Acervo de composições de editais já sincronizadas. Reuso identificado via hash_assinatura (descrição + insumos).';

-- -----------------------------------------------------------------------------
-- 7. LICITACOES (entidade central)
-- -----------------------------------------------------------------------------
CREATE TABLE licitacoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  criado_por UUID NOT NULL REFERENCES profiles(id),

  -- Identificação básica
  titulo TEXT NOT NULL,
  numero_edital TEXT,
  orgao_licitante TEXT,
  municipio TEXT,
  uf CHAR(2),
  data_abertura DATE,
  data_apresentacao_proposta DATE,

  -- Conteúdo extraído (Fase 1)
  objeto TEXT,
  data_base_descricao TEXT,             -- "SINAPI PI 01/2026, SEINFRA CE 28..."
  bases_referencia fonte_referencia[],  -- {SINAPI, SEINFRA, ORSE}
  com_desoneracao BOOLEAN,

  -- Parâmetros financeiros do EDITAL (referência do órgão)
  bdi_referencia_edital NUMERIC(5, 2),
  leis_sociais_referencia NUMERIC(5, 2),
  valor_total_edital NUMERIC(14, 2),

  -- Parâmetros financeiros da PROPOSTA Pavcon (Fase 2)
  proposta_estrategia proposta_estrategia,
  bdi_pavcon NUMERIC(5, 2),
  desconto_percentual NUMERIC(5, 2),    -- nulo ou 0 = sem desconto
  proposta_observacoes TEXT,
  valor_proposta_pavcon NUMERIC(14, 2),

  -- Estado e referências externas
  status licitacao_status NOT NULL DEFAULT 'rascunho',
  orcafascio_grupo_id TEXT REFERENCES orcafascio_grupos_cache(id),
  orcafascio_orcamento_base_id TEXT,    -- espelho do edital
  orcafascio_orcamento_base_codigo TEXT,
  orcafascio_proposta_id TEXT,          -- proposta Pavcon
  orcafascio_proposta_codigo TEXT,

  -- Mensagens de erro humanas para o orçamentista
  erro_mensagem TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  fase1_concluida_em TIMESTAMPTZ,
  finalizada_em TIMESTAMPTZ
);

COMMENT ON COLUMN licitacoes.orcafascio_orcamento_base_id IS
  'ID do orçamento que ESPELHA a planilha do órgão licitante. Read-only após criação.';
COMMENT ON COLUMN licitacoes.orcafascio_proposta_id IS
  'ID da proposta comercial da Pavcon (com desconto/BDI próprios aplicados).';
COMMENT ON COLUMN licitacoes.desconto_percentual IS
  'Pode ser nulo ou 0 quando proposta_estrategia = espelho.';

-- FK reversa em composicoes_edital_sincronizadas (criada agora que licitacoes existe)
ALTER TABLE composicoes_edital_sincronizadas
  ADD CONSTRAINT fk_primeira_licitacao
  FOREIGN KEY (primeira_licitacao_id) REFERENCES licitacoes(id) ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- 8. LICITACAO_ARQUIVOS
-- -----------------------------------------------------------------------------
CREATE TABLE licitacao_arquivos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  licitacao_id UUID NOT NULL REFERENCES licitacoes(id) ON DELETE CASCADE,
  tipo arquivo_tipo NOT NULL,
  storage_bucket TEXT NOT NULL DEFAULT 'editais',
  storage_path TEXT NOT NULL,
  filename_original TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  -- Hash para detectar uploads duplicados / idempotência
  hash_sha256 TEXT,
  total_paginas INT,
  enviado_por UUID NOT NULL REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN licitacao_arquivos.hash_sha256 IS
  'SHA-256 do conteúdo. Permite detectar reupload do mesmo arquivo e reaproveitar extrações.';

-- -----------------------------------------------------------------------------
-- 9. EXTRACOES_OCR (execuções de extração via LLM)
-- -----------------------------------------------------------------------------
-- Separar "execução" de "resultado" permite reprocessar e comparar versões.
CREATE TABLE extracoes_ocr (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  licitacao_id UUID NOT NULL REFERENCES licitacoes(id) ON DELETE CASCADE,
  arquivo_id UUID NOT NULL REFERENCES licitacao_arquivos(id),

  llm_provider credential_provider NOT NULL,
  llm_model TEXT NOT NULL,              -- "gemini-2.5-pro", "claude-opus-4-7"
  prompt_versao TEXT NOT NULL,          -- versionar prompts é crítico

  status extracao_status NOT NULL DEFAULT 'pendente',
  json_extraido JSONB,                  -- objeto, quantitativos, insumos

  -- Custos e performance (essencial para análise de ROI)
  tokens_input INT,
  tokens_output INT,
  custo_usd NUMERIC(10, 4),
  duracao_ms INT,

  -- Revisão humana
  revisado_por UUID REFERENCES profiles(id),
  revisado_em TIMESTAMPTZ,
  json_corrigido JSONB,                 -- versão final pós-revisão

  erro_detalhe TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluido_em TIMESTAMPTZ
);

COMMENT ON COLUMN extracoes_ocr.json_corrigido IS
  'Versão final aprovada pelo orçamentista. Se NULL, usar json_extraido. É essa versão que vai para o cadastro no Orçafascio.';

-- -----------------------------------------------------------------------------
-- 10. COMPOSICOES_EXTRAIDAS (itens estruturados do edital)
-- -----------------------------------------------------------------------------
-- Cada linha da "Planilha Orçamentária" do edital vira um registro aqui.
CREATE TABLE composicoes_extraidas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  licitacao_id UUID NOT NULL REFERENCES licitacoes(id) ON DELETE CASCADE,
  extracao_id UUID NOT NULL REFERENCES extracoes_ocr(id),

  -- Hierarquia do item no edital (ex: "7.5.7" → nivel 3, pai "7.5")
  item_codigo TEXT NOT NULL,
  item_nivel INT NOT NULL,
  item_pai_codigo TEXT,
  tipo_linha TEXT NOT NULL CHECK (tipo_linha IN ('grupo', 'servico')),

  -- Identificação do item
  codigo TEXT,                          -- código SINAPI/SEINFRA/ORSE/COMP_X
  fonte fonte_referencia,
  descricao TEXT NOT NULL,
  unidade TEXT,
  quantidade NUMERIC(14, 4),

  -- Preços do edital (referência do órgão)
  preco_unitario_sem_bdi NUMERIC(14, 4),
  preco_unitario_com_bdi NUMERIC(14, 4),
  preco_total NUMERIC(14, 2),

  -- Após sincronização com o Orçafascio
  orcafascio_resource_id TEXT,
  orcafascio_composition_id TEXT,
  composicao_edital_sinc_id UUID REFERENCES composicoes_edital_sincronizadas(id),

  ordem INT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  UNIQUE (licitacao_id, item_codigo)
);

-- -----------------------------------------------------------------------------
-- 11. COMPOSICAO_PROPRIA_ITENS (sub-itens das composições COMP10, COMP11...)
-- -----------------------------------------------------------------------------
-- Quando uma composicoes_extraidas tem fonte=PROPRIA, seus insumos vão aqui.
CREATE TABLE composicao_propria_itens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  composicao_extraida_id UUID NOT NULL
    REFERENCES composicoes_extraidas(id) ON DELETE CASCADE,
  classe classe_item_composicao NOT NULL,
  codigo TEXT,                          -- "88245", "I0111", "13524/ORSE"
  fonte fonte_referencia NOT NULL,
  descricao TEXT NOT NULL,
  unidade TEXT,
  coeficiente NUMERIC(14, 6),
  preco_unitario NUMERIC(14, 4),
  preco_total NUMERIC(14, 4),
  -- Após sincronização: ID do recurso correspondente no Orçafascio
  orcafascio_resource_id TEXT,
  ordem INT NOT NULL
);

-- -----------------------------------------------------------------------------
-- 12. ANALISES_HISTORICAS (resultado da consulta a orçamentos antigos)
-- -----------------------------------------------------------------------------
CREATE TABLE analises_historicas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  licitacao_id UUID NOT NULL REFERENCES licitacoes(id) ON DELETE CASCADE,
  orcamento_referencia_id TEXT NOT NULL
    REFERENCES orcafascio_orcamentos_cache(id),
  similaridade_score NUMERIC(4, 3),     -- 0.000 a 1.000 (cosine)
  -- Padrões identificados pelo LLM (BDI médio, nomenclaturas usadas, etc)
  padroes_extraidos JSONB,
  -- LLM usado para a síntese (geralmente Claude Opus)
  llm_provider credential_provider,
  llm_model TEXT,
  custo_usd NUMERIC(10, 4),
  usado_como_base BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 13. NOTIFICACOES (in-app)
-- -----------------------------------------------------------------------------
CREATE TABLE notificacoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  licitacao_id UUID REFERENCES licitacoes(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,                   -- 'fase1_concluida', 'erro_extracao', etc
  titulo TEXT NOT NULL,
  mensagem TEXT NOT NULL,
  cta_url TEXT,                         -- link de ação ("ver licitação")
  lida BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lida_em TIMESTAMPTZ
);

-- -----------------------------------------------------------------------------
-- 14. AUDIT_LOG_INTEGRACOES (toda chamada externa fica registrada)
-- -----------------------------------------------------------------------------
-- Tabela append-only. BIGSERIAL por performance (vai crescer rápido).
CREATE TABLE audit_log_integracoes (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES profiles(id),
  licitacao_id UUID REFERENCES licitacoes(id) ON DELETE SET NULL,
  provider credential_provider NOT NULL,
  endpoint TEXT NOT NULL,
  metodo_http TEXT NOT NULL,
  -- Payloads com PII/secrets já mascarados pelo backend antes de salvar
  request_payload JSONB,
  response_status INT,
  response_payload JSONB,
  duracao_ms INT,
  custo_usd NUMERIC(10, 4),
  -- Para correlacionar logs de uma mesma operação lógica
  trace_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE audit_log_integracoes IS
  'Log append-only de TODAS as chamadas a APIs externas. Crítico para debug, auditoria de custos e suporte.';
