-- ============================================================
-- Migration: Estudios de Riesgo Crediticio Feature
-- Adds estado workflow, self-service token, and missing fields
-- ============================================================

-- 1. New enum: estado_estudio (workflow states)
CREATE TYPE estado_estudio AS ENUM (
  'solicitado',
  'pago_pendiente',
  'pagado',
  'autorizado',
  'formulario_enviado',
  'formulario_completado',
  'documentos_cargados',
  'en_proceso',
  'completado',
  'fallido',
  'cancelado'
);

-- 2. Add missing columns to estudios table
ALTER TABLE estudios
  ADD COLUMN estado                       estado_estudio NOT NULL DEFAULT 'solicitado',
  ADD COLUMN pago_por                     VARCHAR(50),
  ADD COLUMN token_self_service           VARCHAR(64) UNIQUE,
  ADD COLUMN expiracion_token             TIMESTAMPTZ,
  ADD COLUMN fecha_solicitud              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN fecha_completado             TIMESTAMPTZ,
  ADD COLUMN fecha_completado_self_service TIMESTAMPTZ,
  ADD COLUMN referencia_proveedor         VARCHAR(200),
  ADD COLUMN datos_formulario             JSONB,
  ADD COLUMN updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- 3. Indexes
CREATE INDEX idx_estudios_estado ON estudios(estado);
CREATE INDEX idx_estudios_token ON estudios(token_self_service) WHERE token_self_service IS NOT NULL;

-- 4. Updated_at trigger
CREATE OR REPLACE FUNCTION update_estudios_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_estudios_updated_at
  BEFORE UPDATE ON estudios
  FOR EACH ROW
  EXECUTE FUNCTION update_estudios_updated_at();
