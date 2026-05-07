-- =============================================================================
-- PAVCON | Sistema de Automação de Licitações Públicas
-- Migration 05: Row Level Security (RLS)
-- =============================================================================
-- Single-tenant: todos os usuários ativos da Pavcon têm acesso de leitura
-- ao acervo compartilhado (licitações, composições). Edição é restrita ao
-- criador ou admin.
--
-- IMPORTANTE: o backend (Edge Functions) usa a service_role key, que
-- bypassa RLS. Estas policies protegem o acesso vindo do FRONTEND
-- (anon key + JWT do usuário).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- HELPER: detecta se o usuário corrente é admin
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND role = 'admin' AND ativo = true
  );
$$;

CREATE OR REPLACE FUNCTION is_active_user()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND ativo = true
  );
$$;

-- -----------------------------------------------------------------------------
-- profiles
-- -----------------------------------------------------------------------------
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Usuário vê próprio perfil + admin vê todos"
  ON profiles FOR SELECT
  USING (id = auth.uid() OR is_admin());

CREATE POLICY "Usuário edita próprio perfil"
  ON profiles FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid() AND role = (SELECT role FROM profiles WHERE id = auth.uid()));

CREATE POLICY "Admin pode editar qualquer perfil"
  ON profiles FOR UPDATE
  USING (is_admin());

-- INSERT é feito pelo trigger handle_new_user (security definer), não precisa policy.
-- DELETE não permitido via RLS (cascade vem de auth.users).

-- -----------------------------------------------------------------------------
-- api_credentials  (sensível! restrito a admin)
-- -----------------------------------------------------------------------------
ALTER TABLE api_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Apenas admin gerencia credenciais"
  ON api_credentials FOR ALL
  USING (is_admin())
  WITH CHECK (is_admin());

-- -----------------------------------------------------------------------------
-- orcafascio_sessoes  (interno, só backend)
-- -----------------------------------------------------------------------------
ALTER TABLE orcafascio_sessoes ENABLE ROW LEVEL SECURITY;
-- Sem policies = ninguém via anon/authenticated acessa. Só service_role.

-- -----------------------------------------------------------------------------
-- orcafascio_grupos_cache  (leitura para todos ativos)
-- -----------------------------------------------------------------------------
ALTER TABLE orcafascio_grupos_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Todos usuários ativos podem ler grupos"
  ON orcafascio_grupos_cache FOR SELECT
  USING (is_active_user());

CREATE POLICY "Apenas admin marca grupo como Setor de Licitação"
  ON orcafascio_grupos_cache FOR UPDATE
  USING (is_admin());

-- -----------------------------------------------------------------------------
-- orcafascio_orcamentos_cache  (acervo compartilhado para análise)
-- -----------------------------------------------------------------------------
ALTER TABLE orcafascio_orcamentos_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Todos usuários ativos leem o acervo histórico"
  ON orcafascio_orcamentos_cache FOR SELECT
  USING (is_active_user());

-- -----------------------------------------------------------------------------
-- composicoes_edital_sincronizadas  (acervo compartilhado)
-- -----------------------------------------------------------------------------
ALTER TABLE composicoes_edital_sincronizadas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Todos usuários ativos leem composições sincronizadas"
  ON composicoes_edital_sincronizadas FOR SELECT
  USING (is_active_user());

-- -----------------------------------------------------------------------------
-- licitacoes
-- -----------------------------------------------------------------------------
ALTER TABLE licitacoes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Usuários ativos veem todas licitações"
  ON licitacoes FOR SELECT
  USING (is_active_user());

CREATE POLICY "Orçamentistas e admins criam licitações"
  ON licitacoes FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
        AND ativo = true
        AND role IN ('admin', 'orcamentista')
    )
    AND criado_por = auth.uid()
  );

CREATE POLICY "Criador ou admin edita licitação"
  ON licitacoes FOR UPDATE
  USING (criado_por = auth.uid() OR is_admin());

CREATE POLICY "Apenas admin deleta licitação"
  ON licitacoes FOR DELETE
  USING (is_admin());

-- -----------------------------------------------------------------------------
-- licitacao_arquivos
-- -----------------------------------------------------------------------------
ALTER TABLE licitacao_arquivos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Acesso a arquivos segue acesso à licitação"
  ON licitacao_arquivos FOR SELECT
  USING (is_active_user());

CREATE POLICY "Criador da licitação adiciona arquivos"
  ON licitacao_arquivos FOR INSERT
  WITH CHECK (
    enviado_por = auth.uid()
    AND EXISTS (
      SELECT 1 FROM licitacoes l
      WHERE l.id = licitacao_id
        AND (l.criado_por = auth.uid() OR is_admin())
    )
  );

-- -----------------------------------------------------------------------------
-- extracoes_ocr  (read all + revisão por orçamentistas)
-- -----------------------------------------------------------------------------
ALTER TABLE extracoes_ocr ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Todos usuários ativos leem extrações"
  ON extracoes_ocr FOR SELECT
  USING (is_active_user());

CREATE POLICY "Criador da licitação ou admin revisa extração"
  ON extracoes_ocr FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM licitacoes l
      WHERE l.id = licitacao_id
        AND (l.criado_por = auth.uid() OR is_admin())
    )
  );

-- -----------------------------------------------------------------------------
-- composicoes_extraidas e composicao_propria_itens
-- -----------------------------------------------------------------------------
ALTER TABLE composicoes_extraidas ENABLE ROW LEVEL SECURITY;
ALTER TABLE composicao_propria_itens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Todos usuários ativos leem composições extraídas"
  ON composicoes_extraidas FOR SELECT
  USING (is_active_user());

CREATE POLICY "Todos usuários ativos leem itens de composições"
  ON composicao_propria_itens FOR SELECT
  USING (is_active_user());

-- INSERT/UPDATE só pelo backend (service_role).

-- -----------------------------------------------------------------------------
-- analises_historicas
-- -----------------------------------------------------------------------------
ALTER TABLE analises_historicas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Todos usuários ativos leem análises"
  ON analises_historicas FOR SELECT
  USING (is_active_user());

CREATE POLICY "Criador da licitação marca análise como base"
  ON analises_historicas FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM licitacoes l
      WHERE l.id = licitacao_id
        AND (l.criado_por = auth.uid() OR is_admin())
    )
  );

-- -----------------------------------------------------------------------------
-- notificacoes  (cada usuário só vê as suas)
-- -----------------------------------------------------------------------------
ALTER TABLE notificacoes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Usuário vê apenas suas notificações"
  ON notificacoes FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Usuário marca como lida apenas suas notificações"
  ON notificacoes FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- -----------------------------------------------------------------------------
-- audit_log_integracoes  (admin lê tudo, ninguém edita)
-- -----------------------------------------------------------------------------
ALTER TABLE audit_log_integracoes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Apenas admin lê audit log"
  ON audit_log_integracoes FOR SELECT
  USING (is_admin());

-- INSERT só pelo backend (service_role). UPDATE/DELETE não permitidos a ninguém
-- via RLS (append-only).
