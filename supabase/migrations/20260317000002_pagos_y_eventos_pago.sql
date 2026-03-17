-- ============================================================
-- Migration: Tablas pagos y eventos_pago
-- Pasarela de pagos integrada con Stripe (patron Adapter)
-- ============================================================

-- 0. Cleanup (safe for re-runs)
DROP TABLE IF EXISTS eventos_pago CASCADE;
DROP TABLE IF EXISTS pagos CASCADE;
DROP TYPE IF EXISTS concepto_pago CASCADE;
DROP TYPE IF EXISTS metodo_pago CASCADE;
DROP TYPE IF EXISTS estado_pago CASCADE;
DROP TYPE IF EXISTS evento_pago_tipo CASCADE;
DROP TYPE IF EXISTS evento_pago_origen CASCADE;

-- 1. Enum types
CREATE TYPE concepto_pago AS ENUM ('estudio', 'garantia', 'primer_canon', 'deposito', 'otro');
CREATE TYPE metodo_pago AS ENUM ('pasarela', 'transferencia', 'efectivo', 'cheque');
CREATE TYPE estado_pago AS ENUM ('pendiente', 'procesando', 'completado', 'fallido', 'reembolsado', 'cancelado');
CREATE TYPE evento_pago_tipo AS ENUM ('created', 'link_sent', 'link_opened', 'processing', 'completed', 'failed', 'refunded', 'cancelled');
CREATE TYPE evento_pago_origen AS ENUM ('system', 'webhook', 'manual');

-- 2. Tabla pagos
CREATE TABLE pagos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Relacion con expediente
  expediente_id UUID NOT NULL REFERENCES expedientes(id) ON DELETE RESTRICT,

  -- Datos del pago
  concepto concepto_pago NOT NULL,
  descripcion TEXT,
  monto NUMERIC(12, 0) NOT NULL CHECK (monto > 0),
  moneda VARCHAR(3) NOT NULL DEFAULT 'COP',
  metodo metodo_pago NOT NULL DEFAULT 'pasarela',
  estado estado_pago NOT NULL DEFAULT 'pendiente',

  -- Pasarela (Stripe)
  payment_link_url TEXT,
  external_id VARCHAR(255),
  transaction_ref VARCHAR(255),
  gateway_response JSONB,

  -- Pago manual
  comprobante_url TEXT,
  notas TEXT,

  -- Fechas
  fecha_pago TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Quien creo el registro
  creado_por UUID NOT NULL REFERENCES perfiles(id)
);

-- Indices
CREATE INDEX idx_pagos_expediente_id ON pagos(expediente_id);
CREATE INDEX idx_pagos_estado ON pagos(estado);
CREATE INDEX idx_pagos_external_id ON pagos(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX idx_pagos_created_at ON pagos(created_at DESC);

-- Trigger updated_at (sin depender de moddatetime)
CREATE OR REPLACE FUNCTION update_pagos_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pagos_updated_at
  BEFORE UPDATE ON pagos
  FOR EACH ROW
  EXECUTE FUNCTION update_pagos_updated_at();

-- 3. Tabla eventos_pago
CREATE TABLE eventos_pago (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Relacion con pago
  pago_id UUID NOT NULL REFERENCES pagos(id) ON DELETE CASCADE,

  -- Datos del evento
  tipo evento_pago_tipo NOT NULL,
  detalles JSONB,
  origen evento_pago_origen NOT NULL DEFAULT 'system',

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_eventos_pago_pago_id ON eventos_pago(pago_id);
CREATE INDEX idx_eventos_pago_tipo ON eventos_pago(tipo);

-- 4. RLS (deshabilitado — usamos service_role desde el backend)
ALTER TABLE pagos ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventos_pago ENABLE ROW LEVEL SECURITY;
