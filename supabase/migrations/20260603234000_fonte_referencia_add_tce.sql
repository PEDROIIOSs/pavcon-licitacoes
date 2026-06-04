-- =============================================================================
-- Adiciona TCE ao enum fonte_referencia
-- =============================================================================
-- Edital de Palmeirais (Piauí, jun/2026) trouxe sub-itens com fonte="TCE"
-- (Tribunal de Contas do Estado), que não estava cadastrado. Extração crashava
-- com: "invalid input value for enum fonte_referencia: TCE".
--
-- TCE é uma fonte genérica — vários tribunais estaduais publicam tabelas
-- de preço próprias. Usamos uma única entry "TCE" e deixamos a UF se
-- reflete na data-base ou no nome do banco no Orçafascio (sem TCE-PI, TCE-MG
-- etc separados, pra não explodir o enum).
-- =============================================================================

ALTER TYPE fonte_referencia ADD VALUE IF NOT EXISTS 'TCE';
