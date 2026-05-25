-- =============================================================================
-- Migration: expandir enum fonte_referencia com bancos públicos suportados
-- =============================================================================
-- O enum original só tinha 7 valores (SINAPI, SICRO, SEINFRA, ORSE, SBC,
-- PROPRIA, OUTRA). Editais reais usam bancos regionais como SEDOP, SETOP,
-- EMBASA, FDE, CPOS, etc — quebravam o insert em composicoes_extraidas com
-- "invalid input value for enum fonte_referencia: 'SEDOP'".
--
-- Os valores adicionados aqui correspondem aos bancos que o Orçafascio
-- reconhece (vide BANK_NORMALIZATION em orcafascio-cadastrar-edital).
-- Bancos desconhecidos viram "OUTRA" via normalizeFonte() no client.
-- =============================================================================

ALTER TYPE fonte_referencia ADD VALUE IF NOT EXISTS 'SICRO3';
ALTER TYPE fonte_referencia ADD VALUE IF NOT EXISTS 'SEDOP';
ALTER TYPE fonte_referencia ADD VALUE IF NOT EXISTS 'SETOP';
ALTER TYPE fonte_referencia ADD VALUE IF NOT EXISTS 'EMBASA';
ALTER TYPE fonte_referencia ADD VALUE IF NOT EXISTS 'FDE';
ALTER TYPE fonte_referencia ADD VALUE IF NOT EXISTS 'CPOS';
ALTER TYPE fonte_referencia ADD VALUE IF NOT EXISTS 'SUDECAP';
ALTER TYPE fonte_referencia ADD VALUE IF NOT EXISTS 'IOPES';
ALTER TYPE fonte_referencia ADD VALUE IF NOT EXISTS 'AGESUL';
ALTER TYPE fonte_referencia ADD VALUE IF NOT EXISTS 'EMOP';
ALTER TYPE fonte_referencia ADD VALUE IF NOT EXISTS 'SCO';
ALTER TYPE fonte_referencia ADD VALUE IF NOT EXISTS 'DERPR';
ALTER TYPE fonte_referencia ADD VALUE IF NOT EXISTS 'CAEMA';
ALTER TYPE fonte_referencia ADD VALUE IF NOT EXISTS 'CAERN';
ALTER TYPE fonte_referencia ADD VALUE IF NOT EXISTS 'COMPESA';
ALTER TYPE fonte_referencia ADD VALUE IF NOT EXISTS 'SIURB';
ALTER TYPE fonte_referencia ADD VALUE IF NOT EXISTS 'AGETOP';
ALTER TYPE fonte_referencia ADD VALUE IF NOT EXISTS 'MAPP';
