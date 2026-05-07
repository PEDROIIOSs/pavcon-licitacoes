-- =============================================================================
-- PAVCON | Sistema de Automação de Licitações Públicas
-- Migration 07: Buckets do Storage + RLS
-- =============================================================================
-- Cria os buckets que a aplicação usa e suas políticas de acesso.
--   editais → PDFs do edital (privado, leitura por authenticated, write por
--             admin/orcamentista)
-- =============================================================================

-- Bucket privado para PDFs de editais
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'editais',
  'editais',
  false,
  104857600,                        -- 100 MB
  ARRAY['application/pdf']
)
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Policies do bucket "editais"
-- -----------------------------------------------------------------------------
-- Limpa policies antigas com mesmo nome (idempotência)
DROP POLICY IF EXISTS "editais_select_authenticated"   ON storage.objects;
DROP POLICY IF EXISTS "editais_insert_admin_orcamentista" ON storage.objects;
DROP POLICY IF EXISTS "editais_update_admin_orcamentista" ON storage.objects;
DROP POLICY IF EXISTS "editais_delete_admin"           ON storage.objects;

-- Leitura: qualquer usuário autenticado e ativo
CREATE POLICY "editais_select_authenticated"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'editais'
    AND auth.role() = 'authenticated'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.ativo = true
    )
  );

-- Insert: admin e orcamentista
CREATE POLICY "editais_insert_admin_orcamentista"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'editais'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND p.ativo = true
        AND p.role IN ('admin', 'orcamentista')
    )
  );

-- Update (raro: re-upload pra corrigir): mesmo critério do insert
CREATE POLICY "editais_update_admin_orcamentista"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'editais'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND p.ativo = true
        AND p.role IN ('admin', 'orcamentista')
    )
  );

-- Delete: só admin
CREATE POLICY "editais_delete_admin"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'editais'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.ativo = true AND p.role = 'admin'
    )
  );
