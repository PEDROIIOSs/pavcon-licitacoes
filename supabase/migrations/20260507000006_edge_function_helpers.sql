-- =============================================================================
-- PAVCON | Sistema de Automação de Licitações Públicas
-- Migration 06: Helpers para Edge Functions (Vault + sessões Orçafascio)
-- =============================================================================
-- Funções SECURITY DEFINER chamáveis via Supabase RPC pelo service_role.
-- Encapsulam acesso ao Vault e operações de cache de auth.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- FUNÇÃO: read_vault_secret
-- -----------------------------------------------------------------------------
-- Resolve o segredo descriptografado a partir do UUID guardado em
-- api_credentials.vault_secret_id. Roda como definidor para acessar o schema
-- vault. É exposto APENAS para o role service_role (Edge Functions).
CREATE OR REPLACE FUNCTION public.read_vault_secret(p_secret_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_secret TEXT;
BEGIN
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets
  WHERE id = p_secret_id;

  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'vault_secret_not_found' USING ERRCODE = 'P0002';
  END IF;

  RETURN v_secret;
END;
$$;

REVOKE ALL ON FUNCTION public.read_vault_secret(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_vault_secret(UUID) TO service_role;

COMMENT ON FUNCTION public.read_vault_secret(UUID) IS
  'Retorna o segredo descriptografado do Vault. Apenas service_role (Edge Functions) tem EXECUTE.';

-- -----------------------------------------------------------------------------
-- FUNÇÃO: upsert_orcafascio_sessao
-- -----------------------------------------------------------------------------
-- Insere ou atualiza a sessão (UNIQUE em credential_id). Usada pela Edge
-- Function orcafascio-auth depois de um login bem-sucedido.
CREATE OR REPLACE FUNCTION public.upsert_orcafascio_sessao(
  p_credential_id UUID,
  p_auth_token TEXT,
  p_orcafascio_user_id TEXT,
  p_orcafascio_company_id TEXT,
  p_orcafascio_department_id TEXT,
  p_email TEXT,
  p_company_name TEXT,
  p_expires_at TIMESTAMPTZ
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO orcafascio_sessoes (
    credential_id, auth_token, orcafascio_user_id, orcafascio_company_id,
    orcafascio_department_id, email, company_name, expires_at
  ) VALUES (
    p_credential_id, p_auth_token, p_orcafascio_user_id, p_orcafascio_company_id,
    p_orcafascio_department_id, p_email, p_company_name, p_expires_at
  )
  ON CONFLICT (credential_id) DO UPDATE
    SET auth_token = EXCLUDED.auth_token,
        orcafascio_user_id = EXCLUDED.orcafascio_user_id,
        orcafascio_company_id = EXCLUDED.orcafascio_company_id,
        orcafascio_department_id = EXCLUDED.orcafascio_department_id,
        email = EXCLUDED.email,
        company_name = EXCLUDED.company_name,
        expires_at = EXCLUDED.expires_at,
        created_at = now()
  RETURNING id INTO v_id;

  -- Marca uso na credencial para auditoria
  UPDATE api_credentials
  SET ultimo_uso_em = now()
  WHERE id = p_credential_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_orcafascio_sessao FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_orcafascio_sessao TO service_role;

-- -----------------------------------------------------------------------------
-- FUNÇÃO: invalidate_orcafascio_sessao
-- -----------------------------------------------------------------------------
-- Remove a sessão cacheada. Chamado quando recebemos 401 do Orçafascio.
CREATE OR REPLACE FUNCTION public.invalidate_orcafascio_sessao(p_credential_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM orcafascio_sessoes WHERE credential_id = p_credential_id;
END;
$$;

REVOKE ALL ON FUNCTION public.invalidate_orcafascio_sessao(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invalidate_orcafascio_sessao(UUID) TO service_role;

-- -----------------------------------------------------------------------------
-- FUNÇÃO: get_orcafascio_active_session
-- -----------------------------------------------------------------------------
-- Variante mais rica de get_orcafascio_token: retorna o registro completo se
-- existir sessão válida, senão NULL. Útil pra Edge Function decidir se devolve
-- do cache ou faz login.
CREATE OR REPLACE FUNCTION public.get_orcafascio_active_session(p_credential_id UUID)
RETURNS TABLE (
  auth_token TEXT,
  orcafascio_user_id TEXT,
  orcafascio_company_id TEXT,
  orcafascio_department_id TEXT,
  email TEXT,
  company_name TEXT,
  expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT s.auth_token, s.orcafascio_user_id, s.orcafascio_company_id,
         s.orcafascio_department_id, s.email, s.company_name, s.expires_at
  FROM orcafascio_sessoes s
  WHERE s.credential_id = p_credential_id
    AND s.expires_at > (now() + interval '5 minutes');
END;
$$;

REVOKE ALL ON FUNCTION public.get_orcafascio_active_session(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_orcafascio_active_session(UUID) TO service_role;
