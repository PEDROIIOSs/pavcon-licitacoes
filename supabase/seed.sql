-- =============================================================================
-- PAVCON | Sistema de Automação de Licitações Públicas
-- Seed - Dados de exemplo baseados no edital real CSPII (Pedro II - PI)
-- =============================================================================
-- Cria uma licitação completa em estado fase1_concluida para você poder
-- testar consultas, RLS e a Fase 2 sem precisar do pipeline completo de OCR.
--
-- ATENÇÃO: Este seed assume que existe pelo menos 1 usuário em auth.users.
-- Crie um usuário via Supabase Studio (Auth > Users > Add user) antes de rodar,
-- ou ajuste o UUID abaixo manualmente.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Pega o primeiro usuário disponível em auth.users (qualquer um)
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_user_id UUID;
  v_licitacao_id UUID := 'a1b2c3d4-0001-4000-8000-000000000001'::uuid;
  v_arquivo_id UUID := 'a1b2c3d4-0002-4000-8000-000000000001'::uuid;
  v_extracao_id UUID := 'a1b2c3d4-0003-4000-8000-000000000001'::uuid;
  v_comp_propria_id UUID;
BEGIN
  SELECT id INTO v_user_id FROM auth.users LIMIT 1;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Nenhum usuário em auth.users. Crie um via Supabase Studio antes de rodar o seed.';
  END IF;

  -- Garante que o profile existe e é admin (para testar RLS de admin)
  UPDATE profiles SET role = 'admin', nome_completo = 'Orçamentista Pavcon (Seed)'
  WHERE id = v_user_id;

  -- ---------------------------------------------------------------------------
  -- 1. Licitação CSPII (estado fase1_concluida)
  -- ---------------------------------------------------------------------------
  INSERT INTO licitacoes (
    id, criado_por, titulo, numero_edital, orgao_licitante,
    municipio, uf, objeto, data_base_descricao, bases_referencia,
    com_desoneracao, bdi_referencia_edital, leis_sociais_referencia,
    valor_total_edital, status, fase1_concluida_em
  ) VALUES (
    v_licitacao_id,
    v_user_id,
    'Construção de Campo Society - Pedro II/PI',
    'EDITAL-CSPII-2026-001',
    'MUNICÍPIO DE PEDRO II - PI',
    'Pedro II',
    'PI',
    'CONSTRUÇÃO DE CAMPO SOCIETY COM VESTIÁRIO E ARQUIBANCADA NO MUNICÍPIO DE PEDRO II - PI',
    'SINAPI PI 01/2026, SEINFRA CE 28, ORSE SE 01/2026, SEM DESONERAÇÃO',
    ARRAY['SINAPI', 'SEINFRA', 'ORSE']::fonte_referencia[],
    false,
    22.12,
    113.78,
    NULL,  -- preencher após somar todos os itens
    -- Forçamos status direto via UPDATE para bypassar a validação da máquina
    -- (no fluxo real ela passaria por todos os estados intermediários)
    'rascunho'::licitacao_status,
    NULL
  );

  -- Atualiza para fase1_concluida sem disparar a validação (precisamos de um
  -- caminho válido). Isso simula que tudo já foi processado.
  -- Truque: passar por cada estado intermediário rapidamente.
  UPDATE licitacoes SET status = 'aguardando_extracao' WHERE id = v_licitacao_id;
  UPDATE licitacoes SET status = 'extraindo' WHERE id = v_licitacao_id;
  UPDATE licitacoes SET status = 'extracao_concluida' WHERE id = v_licitacao_id;
  UPDATE licitacoes SET status = 'aguardando_revisao_humana' WHERE id = v_licitacao_id;
  UPDATE licitacoes SET status = 'criando_composicoes_edital' WHERE id = v_licitacao_id;
  UPDATE licitacoes SET status = 'criando_orcamento_base' WHERE id = v_licitacao_id;
  UPDATE licitacoes SET status = 'fase1_concluida' WHERE id = v_licitacao_id;

  -- ---------------------------------------------------------------------------
  -- 2. Arquivo do edital (mock - sem o PDF de fato)
  -- ---------------------------------------------------------------------------
  INSERT INTO licitacao_arquivos (
    id, licitacao_id, tipo, storage_bucket, storage_path,
    filename_original, mime_type, size_bytes, hash_sha256,
    total_paginas, enviado_por
  ) VALUES (
    v_arquivo_id,
    v_licitacao_id,
    'planilha_orcamentaria',
    'editais',
    format('licitacoes/%s/edital_cspii.pdf', v_licitacao_id),
    'PLANILHAS_ORÇAMENTÁRIAS_CSPII.pdf',
    'application/pdf',
    2648780,
    'placeholder_sha256_do_pdf_real',
    120,
    v_user_id
  );

  -- ---------------------------------------------------------------------------
  -- 3. Extração OCR (simulada como bem-sucedida)
  -- ---------------------------------------------------------------------------
  INSERT INTO extracoes_ocr (
    id, licitacao_id, arquivo_id, llm_provider, llm_model,
    prompt_versao, status, tokens_input, tokens_output,
    custo_usd, duracao_ms, concluido_em,
    json_extraido
  ) VALUES (
    v_extracao_id,
    v_licitacao_id,
    v_arquivo_id,
    'gemini',
    'gemini-2.5-pro',
    'pavcon-extracao-edital-v1',
    'sucesso',
    285000,  -- 120 páginas é caro
    18500,
    1.42,
    47820,
    now() - interval '2 hours',
    jsonb_build_object(
      'cabecalho', jsonb_build_object(
        'orgao', 'MUNICÍPIO DE PEDRO II - PI',
        'objeto', 'CONSTRUÇÃO DE CAMPO SOCIETY COM VESTIÁRIO E ARQUIBANCADA',
        'bdi', 22.12,
        'leis_sociais', 113.78
      ),
      'total_itens_extraidos', 158
    )
  );

  -- ---------------------------------------------------------------------------
  -- 4. Composições extraídas (amostra de itens variados do PDF)
  -- ---------------------------------------------------------------------------

  -- Item-grupo de nível 1 (não tem preços, só agrega)
  INSERT INTO composicoes_extraidas (
    licitacao_id, extracao_id, item_codigo, item_nivel, tipo_linha,
    descricao, ordem
  ) VALUES (
    v_licitacao_id, v_extracao_id, '5', 1, 'grupo',
    'INSTALAÇÕES ELÉTRICAS DO CAMPO SOCIETY', 1
  );

  -- Item de nível 2
  INSERT INTO composicoes_extraidas (
    licitacao_id, extracao_id, item_codigo, item_nivel, item_pai_codigo,
    tipo_linha, descricao, ordem
  ) VALUES (
    v_licitacao_id, v_extracao_id, '5.1', 2, '5',
    'grupo', 'INSTALAÇÕES ELÉTRICAS DO CAMPO SOCIETY', 2
  );

  -- Item SINAPI (referência simples)
  INSERT INTO composicoes_extraidas (
    licitacao_id, extracao_id, item_codigo, item_nivel, item_pai_codigo,
    tipo_linha, codigo, fonte, descricao, unidade, quantidade,
    preco_unitario_sem_bdi, preco_unitario_com_bdi, preco_total, ordem
  ) VALUES (
    v_licitacao_id, v_extracao_id, '5.1.2', 3, '5.1',
    'servico', '98111', 'SINAPI',
    'CAIXA DE INSPEÇÃO PARA ATERRAMENTO, CIRCULAR, EM POLIETILENO, DIÂMETRO INTERNO = 0,3 M. AF_12/2020',
    'UN', 3.00, 46.89, 57.26, 171.78, 3
  );

  -- Item COMP11 (composição PRÓPRIA - exemplo do edital)
  INSERT INTO composicoes_extraidas (
    licitacao_id, extracao_id, item_codigo, item_nivel, item_pai_codigo,
    tipo_linha, codigo, fonte, descricao, unidade, quantidade,
    ordem
  ) VALUES (
    v_licitacao_id, v_extracao_id, '5.1.5', 3, '5.1',
    'servico', 'COMP11', 'PROPRIA',
    'CONJUNTO REFLETOR LED 4 X 200 W (4 UNIDADES) FIXADAS EM POSTE DE CONCRETO ARMADO 10 M X 300 KGF E REFLETOR LED 100 W PARA ILUMINAÇÃO DE CIRCULAÇÃO - FORNECIMENTO E INSTALAÇÃO',
    'CJ', 1.00, 4
  ) RETURNING id INTO v_comp_propria_id;

  -- Itens DETALHADOS da composição própria COMP11 (insumos reais do PDF)
  INSERT INTO composicao_propria_itens (
    composicao_extraida_id, classe, codigo, fonte, descricao,
    unidade, coeficiente, preco_unitario, preco_total, ordem
  ) VALUES
  (
    v_comp_propria_id, 'INSUMO', '436', 'SINAPI',
    'PARAFUSO FRANCES M16 EM ACO GALVANIZADO, COMPRIMENTO = 150 MM, DIAMETRO = 16 MM, CABECA ABAULADA',
    'UN', 2.0, 12.13, 24.26, 1
  ),
  (
    v_comp_propria_id, 'INSUMO', '13524/ORSE', 'ORSE',
    'REFLETOR SLIM LED 200W DE POTÊNCIA, BRANCO FRIO, 6500K, AUTOVOLT, MARCA G-LIGHT OU SIMILAR',
    'UN', 4.0, 109.89, 439.56, 2
  ),
  (
    v_comp_propria_id, 'INSUMO', '13289/ORSE', 'ORSE',
    'REFLETOR LED 100W, BRANCO FRIO, AUTOVOLT, MARCA G-LIGHT OU SIMILAR',
    'UN', 1.0, 78.50, 78.50, 3
  );

  -- Item SEINFRA
  INSERT INTO composicoes_extraidas (
    licitacao_id, extracao_id, item_codigo, item_nivel, item_pai_codigo,
    tipo_linha, codigo, fonte, descricao, unidade, quantidade,
    preco_unitario_sem_bdi, preco_unitario_com_bdi, preco_total, ordem
  ) VALUES (
    v_licitacao_id, v_extracao_id, '6.1.2', 3, '6.1',
    'servico', 'COMP10', 'PROPRIA',
    'ATERRO C/COMPACTAÇÃO MANUAL S/CONTROLE, MAT. C/AQUISIÇÃO (REF: C0330-SEINFRA 28)',
    'M3', 12.50, 89.45, 109.23, 1365.38, 5
  );

  -- ---------------------------------------------------------------------------
  -- 5. Notificação de exemplo
  -- ---------------------------------------------------------------------------
  INSERT INTO notificacoes (user_id, licitacao_id, tipo, titulo, mensagem, cta_url)
  VALUES (
    v_user_id,
    v_licitacao_id,
    'fase1_concluida',
    'Fase 1 concluída: CSPII Pedro II',
    'O orçamento do edital foi cadastrado com sucesso no Orçafascio. Agora você pode definir a estratégia da proposta Pavcon.',
    format('/licitacoes/%s/proposta', v_licitacao_id)
  );

  RAISE NOTICE 'Seed criado com sucesso!';
  RAISE NOTICE 'Licitação ID: %', v_licitacao_id;
  RAISE NOTICE 'Status: fase1_concluida (pronta para definir proposta da Pavcon)';
END $$;
