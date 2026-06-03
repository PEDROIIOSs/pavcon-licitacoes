-- =============================================================================
-- OrçaPav AI Agent — base de conhecimento + log de atividade
-- =============================================================================
-- Estratégia: o worker consulta orcapav_knowledge_codes ANTES de chamar
-- Gemini Flash. Códigos conhecidos viram fix em milissegundos. Códigos
-- desconhecidos vão pro Gemini, e o resultado é salvo na base pra próximas
-- vezes (auto-aprendizado).
-- =============================================================================

CREATE TABLE IF NOT EXISTS orcapav_knowledge_codes (
  id BIGSERIAL PRIMARY KEY,
  fonte_original TEXT NOT NULL,            -- ex: SINAPI
  codigo_original TEXT NOT NULL,           -- ex: 6111
  fonte_substituto TEXT NOT NULL,          -- ex: SINAPI
  codigo_substituto TEXT NOT NULL,         -- ex: 88316
  descricao TEXT,                          -- contexto humano
  motivo TEXT,                             -- por que esse é o equivalente
  fonte_descoberta TEXT NOT NULL DEFAULT 'manual',  -- manual | gemini | claude | aprendido_do_uso
  confianca SMALLINT DEFAULT 100 CHECK (confianca BETWEEN 0 AND 100),
  vezes_aplicado INT DEFAULT 0,            -- contador de uso
  vezes_validado INT DEFAULT 0,            -- usuário aprovou explícitamente
  ultima_aplicacao TIMESTAMPTZ,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ DEFAULT now(),
  UNIQUE (fonte_original, codigo_original)
);

CREATE INDEX IF NOT EXISTS idx_orcapav_kc_busca
  ON orcapav_knowledge_codes(fonte_original, codigo_original);

COMMENT ON TABLE orcapav_knowledge_codes IS
'Base de conhecimento de migrações de código (SINAPI legacy → moderno, etc). Worker consulta aqui antes de gastar tokens do Gemini.';

CREATE TABLE IF NOT EXISTS orcapav_correcoes_log (
  id BIGSERIAL PRIMARY KEY,
  licitacao_id UUID REFERENCES licitacoes(id) ON DELETE CASCADE,
  rodada_em TIMESTAMPTZ DEFAULT now(),
  duracao_ms INT,
  source TEXT NOT NULL,                    -- knowledge_base | gemini_flash | claude_sonnet | manual
  acao TEXT NOT NULL,                      -- ex: salvar_mapeamento_code, reclassificar_codes
  detalhes JSONB NOT NULL DEFAULT '{}'::jsonb,
  sucesso BOOLEAN DEFAULT TRUE,
  erro TEXT
);

CREATE INDEX IF NOT EXISTS idx_orcapav_log_licitacao
  ON orcapav_correcoes_log(licitacao_id, rodada_em DESC);

COMMENT ON TABLE orcapav_correcoes_log IS
'Log de cada correção tentada pelo agente. Útil pra dashboard e debug.';

-- =============================================================================
-- RLS — qualquer user autenticado pode LER, só service role escreve
-- =============================================================================
ALTER TABLE orcapav_knowledge_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE orcapav_correcoes_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS orcapav_kc_select ON orcapav_knowledge_codes;
CREATE POLICY orcapav_kc_select ON orcapav_knowledge_codes
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS orcapav_log_select ON orcapav_correcoes_log;
CREATE POLICY orcapav_log_select ON orcapav_correcoes_log
  FOR SELECT USING (auth.role() = 'authenticated');

-- =============================================================================
-- SEED — mappings conhecidos de mão-de-obra SINAPI (migração com encargos)
-- =============================================================================
INSERT INTO orcapav_knowledge_codes
  (fonte_original, codigo_original, fonte_substituto, codigo_substituto, descricao, motivo, fonte_descoberta, confianca)
VALUES
  ('SINAPI', '244',  'SINAPI', '88253', 'AUXILIAR DE TOPOGRAFO COM ENCARGOS COMPLEMENTARES', 'Migração oficial labor 2014+', 'manual', 100),
  ('SINAPI', '6111', 'SINAPI', '88316', 'SERVENTE COM ENCARGOS COMPLEMENTARES', 'Migração oficial labor 2014+', 'manual', 100),
  ('SINAPI', '7592', 'SINAPI', '91387', 'TOPOGRAFO COM ENCARGOS COMPLEMENTARES', 'Migração oficial labor 2014+', 'manual', 100),
  ('SINAPI', '88245', 'SINAPI', '88309', 'PEDREIRO COM ENCARGOS COMPLEMENTARES', 'Migração oficial labor 2014+', 'manual', 100),
  ('SINAPI', '88247', 'SINAPI', '88310', 'MESTRE DE OBRAS COM ENCARGOS COMPLEMENTARES', 'Migração oficial labor', 'manual', 95),
  ('SINAPI', '88248', 'SINAPI', '88311', 'ENCARREGADO COM ENCARGOS COMPLEMENTARES', 'Migração oficial labor', 'manual', 95),
  ('SINAPI', '88239', 'SINAPI', '88339', 'ENGENHEIRO CIVIL JR COM ENCARGOS', 'Migração oficial labor', 'manual', 90),
  ('SINAPI', '88243', 'SINAPI', '88307', 'CARPINTEIRO DE FORMAS COM ENCARGOS', 'Migração oficial labor', 'manual', 95),
  ('SINAPI', '88249', 'SINAPI', '88313', 'ARMADOR COM ENCARGOS', 'Migração oficial labor', 'manual', 95),
  ('SINAPI', '88256', 'SINAPI', '88320', 'AJUDANTE ESPECIALIZADO COM ENCARGOS', 'Migração oficial labor', 'manual', 90),
  ('SINAPI', '88259', 'SINAPI', '88323', 'AJUDANTE DE ARMADOR COM ENCARGOS', 'Migração oficial labor', 'manual', 90),
  ('SINAPI', '88264', 'SINAPI', '88328', 'AJUDANTE DE CARPINTEIRO COM ENCARGOS', 'Migração oficial labor', 'manual', 90),
  ('SINAPI', '88267', 'SINAPI', '88331', 'AJUDANTE DE PEDREIRO COM ENCARGOS', 'Migração oficial labor', 'manual', 90),
  ('SINAPI', '88278', 'SINAPI', '88342', 'OPERADOR DE BETONEIRA COM ENCARGOS', 'Migração oficial labor', 'manual', 90),
  ('SINAPI', '88301', 'SINAPI', '88365', 'ELETRICISTA COM ENCARGOS COMPLEMENTARES', 'Migração oficial labor', 'manual', 95),
  ('SINAPI', '88302', 'SINAPI', '88366', 'PINTOR COM ENCARGOS COMPLEMENTARES', 'Migração oficial labor', 'manual', 95),
  ('SINAPI', '88303', 'SINAPI', '88367', 'GESSEIRO COM ENCARGOS COMPLEMENTARES', 'Migração oficial labor', 'manual', 90),
  ('SINAPI', '88304', 'SINAPI', '88368', 'IMPERMEABILIZADOR COM ENCARGOS', 'Migração oficial labor', 'manual', 90),
  ('SINAPI', '88305', 'SINAPI', '88369', 'AZULEJISTA / LADRILHEIRO COM ENCARGOS', 'Migração oficial labor', 'manual', 90),
  ('SINAPI', '88306', 'SINAPI', '88370', 'MARMORISTA COM ENCARGOS', 'Migração oficial labor', 'manual', 90),
  ('SINAPI', '88314', 'SINAPI', '88378', 'BOMBEIRO HIDRAULICO COM ENCARGOS', 'Migração oficial labor', 'manual', 95),
  ('SINAPI', '88323', 'SINAPI', '88387', 'CALDEIREIRO COM ENCARGOS', 'Migração oficial labor', 'manual', 90),
  ('SINAPI', '88325', 'SINAPI', '88389', 'SOLDADOR COM ENCARGOS', 'Migração oficial labor', 'manual', 90),
  ('SINAPI', '88330', 'SINAPI', '88394', 'ENCANADOR COM ENCARGOS', 'Migração oficial labor', 'manual', 95)
ON CONFLICT (fonte_original, codigo_original) DO NOTHING;
