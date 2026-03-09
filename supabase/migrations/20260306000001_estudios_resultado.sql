-- ============================================================
-- Migration: Add resultado fields to estudios
-- Supports motivo_rechazo and condiciones for study results
-- ============================================================

ALTER TABLE estudios
  ADD COLUMN motivo_rechazo TEXT,
  ADD COLUMN condiciones    TEXT;

-- Index for analytics on resultado
CREATE INDEX idx_estudios_resultado ON estudios(resultado) WHERE resultado != 'pendiente';
