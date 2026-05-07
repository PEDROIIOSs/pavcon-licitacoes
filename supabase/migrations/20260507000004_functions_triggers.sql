-- =============================================================================
-- PAVCON | Sistema de Automação de Licitações Públicas
-- Migration 04: Funções e Triggers
-- =============================================================================
-- Lógica de domínio embutida no banco: trigger updated_at, validação da máquina
-- de estados, helper para Vault.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- TRIGGER: atualiza updated_at automaticamente
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_credentials_updated_at
  BEFORE UPDATE ON api_credentials
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_licitacoes_updated_at
  BEFORE UPDATE ON licitacoes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- TRIGGER: cria profile automaticamente quando um usuário é criado em auth.users
-- -----------------------------------------------------------------------------
-- Roda no schema auth pelo Supabase Auth quando alguém faz signup.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, nome_completo, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'nome_completo', split_part(NEW.email, '@', 1)),
    -- Por padrão novo usuário entra como orcamentista. Admin promove depois.
    'orcamentista'::user_role
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- -----------------------------------------------------------------------------
-- FUNÇÃO: valida transições de status da licitação (máquina de estados)
-- -----------------------------------------------------------------------------
-- Garante que mudanças de status seguem o fluxo correto.
-- Use SEMPRE via UPDATE (não bypass), e o trigger abaixo valida.
CREATE OR REPLACE FUNCTION validate_licitacao_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  valid BOOLEAN := false;
BEGIN
  -- Sem mudança de status, nada a validar
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  -- Sempre permitido: ir para 'erro' ou 'arquivada' a partir de qualquer estado
  IF NEW.status IN ('erro', 'arquivada') THEN
    RETURN NEW;
  END IF;

  -- Sempre permitido: sair de 'erro' voltando ao estado anterior (retry)
  -- (a aplicação é responsável por setar o estado correto)
  IF OLD.status = 'erro' THEN
    RETURN NEW;
  END IF;

  -- Transições válidas (caminho feliz)
  valid := CASE OLD.status
    WHEN 'rascunho' THEN
      NEW.status IN ('aguardando_extracao')

    WHEN 'aguardando_extracao' THEN
      NEW.status IN ('extraindo')

    WHEN 'extraindo' THEN
      NEW.status IN ('extracao_concluida')

    WHEN 'extracao_concluida' THEN
      NEW.status IN ('aguardando_revisao_humana', 'criando_composicoes_edital')

    WHEN 'aguardando_revisao_humana' THEN
      NEW.status IN ('criando_composicoes_edital')

    WHEN 'criando_composicoes_edital' THEN
      NEW.status IN ('criando_orcamento_base')

    WHEN 'criando_orcamento_base' THEN
      NEW.status IN ('fase1_concluida')

    -- Fase 1 concluída pode ficar parada ou avançar para Fase 2
    WHEN 'fase1_concluida' THEN
      NEW.status IN ('definindo_estrategia')

    WHEN 'definindo_estrategia' THEN
      NEW.status IN ('gerando_proposta')

    WHEN 'gerando_proposta' THEN
      NEW.status IN ('finalizado')

    -- 'finalizado' e 'arquivada' são estados terminais (só erro pode forçar saída)
    ELSE false
  END;

  IF NOT valid THEN
    RAISE EXCEPTION 'Transição de status inválida: % -> %', OLD.status, NEW.status
      USING HINT = 'Verifique a máquina de estados em validate_licitacao_status_transition()';
  END IF;

  -- Marcas temporais automáticas
  IF NEW.status = 'fase1_concluida' AND NEW.fase1_concluida_em IS NULL THEN
    NEW.fase1_concluida_em := now();
  END IF;

  IF NEW.status = 'finalizado' AND NEW.finalizada_em IS NULL THEN
    NEW.finalizada_em := now();
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_licitacao_status
  BEFORE UPDATE OF status ON licitacoes
  FOR EACH ROW EXECUTE FUNCTION validate_licitacao_status_transition();

-- -----------------------------------------------------------------------------
-- FUNÇÃO: normaliza descrição para hash de assinatura
-- -----------------------------------------------------------------------------
-- Usada para detectar composições equivalentes mesmo com pequenas diferenças
-- de espaçamento/case. A aplicação chama isso antes de hashear (descricao + insumos).
CREATE OR REPLACE FUNCTION normalizar_descricao(input TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  RETURN regexp_replace(
    upper(trim(input)),
    '\s+', ' ', 'g'
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- FUNÇÃO: incrementa contador de reúso de composição
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION incrementar_reuso_composicao(p_hash TEXT)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_id UUID;
BEGIN
  UPDATE composicoes_edital_sincronizadas
  SET vezes_reutilizada = vezes_reutilizada + 1,
      ultima_utilizacao_em = now()
  WHERE hash_assinatura = p_hash
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- FUNÇÃO: helper para resolver auth_token válido do Orçafascio
-- -----------------------------------------------------------------------------
-- Retorna o auth_token se existe sessão válida, ou NULL se precisa relogar.
-- A aplicação (Edge Function) é responsável por chamar o login se NULL.
CREATE OR REPLACE FUNCTION get_orcafascio_token(p_credential_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_token TEXT;
BEGIN
  SELECT auth_token INTO v_token
  FROM orcafascio_sessoes
  WHERE credential_id = p_credential_id
    -- Renova quando faltar menos de 5 minutos para expirar
    AND expires_at > (now() + interval '5 minutes');

  RETURN v_token;
END;
$$;

-- -----------------------------------------------------------------------------
-- VIEW: dashboard de licitações com agregações úteis
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_dashboard_licitacoes AS
SELECT
  l.id,
  l.titulo,
  l.numero_edital,
  l.orgao_licitante,
  l.municipio,
  l.uf,
  l.status,
  l.data_abertura,
  l.valor_total_edital,
  l.valor_proposta_pavcon,
  l.bdi_referencia_edital,
  l.bdi_pavcon,
  l.desconto_percentual,
  p.nome_completo AS criado_por_nome,
  l.created_at,
  l.fase1_concluida_em,
  l.finalizada_em,
  -- Contagens úteis para o painel
  (SELECT COUNT(*) FROM licitacao_arquivos WHERE licitacao_id = l.id) AS qtd_arquivos,
  (SELECT COUNT(*) FROM composicoes_extraidas WHERE licitacao_id = l.id) AS qtd_itens_extraidos,
  (SELECT COUNT(*) FROM composicoes_extraidas
    WHERE licitacao_id = l.id AND fonte = 'PROPRIA') AS qtd_composicoes_proprias,
  -- Indica se está aguardando ação humana
  (l.status IN ('aguardando_revisao_humana', 'fase1_concluida', 'definindo_estrategia')) AS aguarda_acao_humana
FROM licitacoes l
JOIN profiles p ON p.id = l.criado_por;

COMMENT ON VIEW vw_dashboard_licitacoes IS
  'View consolidada para o dashboard. Inclui contagens e flag de "aguarda ação humana".';
