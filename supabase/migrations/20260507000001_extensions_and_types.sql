-- =============================================================================
-- PAVCON | Sistema de Automação de Licitações Públicas
-- Migration 01: Extensões e Tipos
-- =============================================================================
-- Habilita extensões necessárias e cria os ENUMs do domínio.
-- Rodar PRIMEIRO - todas as outras migrations dependem desta.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- EXTENSÕES
-- -----------------------------------------------------------------------------

-- gen_random_uuid() para PKs
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Busca por similaridade semântica (análise histórica de orçamentos)
CREATE EXTENSION IF NOT EXISTS "vector";

-- Para hash em índices/buscas (hash_assinatura de composições)
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- -----------------------------------------------------------------------------
-- ENUMS
-- -----------------------------------------------------------------------------

-- Papéis dos usuários internos da Pavcon
CREATE TYPE user_role AS ENUM (
  'admin',         -- gestão de credenciais, usuários
  'orcamentista',  -- operação principal
  'visualizador'   -- somente leitura (gerentes, sócios)
);

-- Provedores de API externos cujas credenciais armazenamos no Vault
CREATE TYPE credential_provider AS ENUM (
  'orcafascio',
  'anthropic',     -- Claude (orquestrador)
  'gemini',        -- Google Gemini (OCR/Vision)
  'openai',        -- fallback ou embeddings
  'voyage'         -- embeddings (recomendado pela Anthropic)
);

-- Máquina de estados da licitação
-- IMPORTANTE: a ordem importa. Transições válidas estão na função
-- transition_licitacao_status() em 20260507000004_functions_triggers.sql
CREATE TYPE licitacao_status AS ENUM (
  -- Setup inicial
  'rascunho',

  -- FASE 1: Espelhamento do edital
  'aguardando_extracao',
  'extraindo',
  'extracao_concluida',
  'aguardando_revisao_humana',
  'criando_composicoes_edital',
  'criando_orcamento_base',
  'fase1_concluida',           -- ★ ponto natural de pausa

  -- FASE 2: Geração da proposta Pavcon
  'definindo_estrategia',
  'gerando_proposta',
  'finalizado',

  -- Estados especiais
  'erro',
  'arquivada'
);

-- Tipos de arquivo que podem ser anexados a uma licitação
CREATE TYPE arquivo_tipo AS ENUM (
  'edital',
  'planilha_orcamentaria',
  'memorial_descritivo',
  'projeto_tecnico',
  'anexo'
);

-- Fontes de referência para insumos e composições
-- Reflete o que vimos no edital CSPII real (multi-fonte)
CREATE TYPE fonte_referencia AS ENUM (
  'SINAPI',      -- Federal (Caixa)
  'SICRO',       -- DNIT
  'SEINFRA',     -- Ceará
  'ORSE',        -- Sergipe
  'SBC',         -- São Paulo
  'PROPRIA',     -- Composições próprias do edital
  'OUTRA'
);

-- Status de uma execução de extração via LLM
CREATE TYPE extracao_status AS ENUM (
  'pendente',
  'processando',
  'sucesso',
  'falha',
  'revisada_humano' -- após validação manual
);

-- Estratégia da proposta Pavcon (Fase 2)
CREATE TYPE proposta_estrategia AS ENUM (
  'espelho',           -- proposta = orçamento do edital sem alteração de preço
  'desconto_linear',   -- desconto único aplicado em todos os itens
  'desconto_por_item', -- desconto diferenciado por item (futuro)
  'bdi_alterado'       -- mantém preços, altera apenas BDI
);

-- Classes de itens dentro de uma composição
CREATE TYPE classe_item_composicao AS ENUM (
  'INSUMO',
  'COMPOSICAO',  -- composição auxiliar (ex: mão-de-obra)
  'MAT',         -- material (variante usada por SEINFRA)
  'EQUIPAMENTO'
);

COMMENT ON TYPE licitacao_status IS
  'Estados da licitação. Fase 1 = espelhamento do edital. Fase 2 = proposta Pavcon. Transições controladas em transition_licitacao_status().';

COMMENT ON TYPE proposta_estrategia IS
  'Como a Pavcon vai derivar a proposta do orçamento do órgão. "espelho" = sem desconto, apenas duplicado.';
