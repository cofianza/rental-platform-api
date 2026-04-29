-- ============================================================
-- Migration: Creditos de estudios para inmobiliarias
--
-- Permite a las inmobiliarias comprar paquetes de estudios y
-- liberar manualmente cada estudio para sus solicitantes.
--
-- Tablas:
--   1. paquetes_creditos_estudios — catalogo configurable (super admin)
--   2. compras_creditos_estudios — registro de compras (Stripe)
--   3. lotes_creditos_estudios — saldo en lotes con FIFO + vencimiento
--   4. movimientos_creditos_estudios — bitacora de consumos / ajustes
-- ============================================================

-- 0. Cleanup
DROP TABLE IF EXISTS movimientos_creditos_estudios CASCADE;
DROP TABLE IF EXISTS lotes_creditos_estudios CASCADE;
DROP TABLE IF EXISTS compras_creditos_estudios CASCADE;
DROP TABLE IF EXISTS paquetes_creditos_estudios CASCADE;
DROP TYPE IF EXISTS estado_compra_creditos CASCADE;
DROP TYPE IF EXISTS tipo_movimiento_creditos CASCADE;
DROP TYPE IF EXISTS origen_lote_creditos CASCADE;

-- 1. Enums
CREATE TYPE estado_compra_creditos AS ENUM ('pendiente', 'completado', 'fallido', 'cancelado');
CREATE TYPE tipo_movimiento_creditos AS ENUM ('compra', 'consumo', 'expiracion', 'ajuste');
CREATE TYPE origen_lote_creditos AS ENUM ('compra', 'ajuste_admin');

-- 2. Paquetes (catalogo configurable)
CREATE TABLE paquetes_creditos_estudios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre VARCHAR(100) NOT NULL,
  descripcion TEXT,
  cantidad_estudios INTEGER NOT NULL CHECK (cantidad_estudios > 0),
  precio_cop INTEGER NOT NULL CHECK (precio_cop > 0),
  vence_en_dias INTEGER CHECK (vence_en_dias IS NULL OR vence_en_dias > 0),
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  orden INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_paquetes_creditos_activo ON paquetes_creditos_estudios(activo, orden);

-- 3. Compras (registro de Stripe Checkout)
CREATE TABLE compras_creditos_estudios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  perfil_id UUID NOT NULL REFERENCES perfiles(id) ON DELETE RESTRICT,
  paquete_id UUID NOT NULL REFERENCES paquetes_creditos_estudios(id) ON DELETE RESTRICT,

  -- Snapshot del paquete al momento de la compra
  cantidad_estudios INTEGER NOT NULL CHECK (cantidad_estudios > 0),
  precio_cop INTEGER NOT NULL CHECK (precio_cop > 0),
  vence_en_dias INTEGER,

  estado estado_compra_creditos NOT NULL DEFAULT 'pendiente',

  -- Stripe
  stripe_session_id VARCHAR(255) UNIQUE,
  stripe_payment_intent_id VARCHAR(255),
  payment_link_url TEXT,
  gateway_response JSONB,

  -- Fechas
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  creado_por UUID REFERENCES perfiles(id)
);

CREATE INDEX idx_compras_creditos_perfil ON compras_creditos_estudios(perfil_id, created_at DESC);
CREATE INDEX idx_compras_creditos_estado ON compras_creditos_estudios(estado);
CREATE INDEX idx_compras_creditos_session ON compras_creditos_estudios(stripe_session_id) WHERE stripe_session_id IS NOT NULL;

-- 4. Lotes (FIFO + vencimiento opcional)
CREATE TABLE lotes_creditos_estudios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  perfil_id UUID NOT NULL REFERENCES perfiles(id) ON DELETE RESTRICT,
  compra_id UUID REFERENCES compras_creditos_estudios(id) ON DELETE RESTRICT,

  cantidad_inicial INTEGER NOT NULL CHECK (cantidad_inicial > 0),
  cantidad_disponible INTEGER NOT NULL CHECK (cantidad_disponible >= 0),

  vence_en TIMESTAMPTZ, -- NULL = perpetuo
  origen origen_lote_creditos NOT NULL,
  notas TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CHECK (cantidad_disponible <= cantidad_inicial)
);

CREATE INDEX idx_lotes_creditos_perfil ON lotes_creditos_estudios(perfil_id, created_at);
CREATE INDEX idx_lotes_creditos_disponibles ON lotes_creditos_estudios(perfil_id, vence_en, created_at)
  WHERE cantidad_disponible > 0;

-- 5. Movimientos (bitacora)
CREATE TABLE movimientos_creditos_estudios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  perfil_id UUID NOT NULL REFERENCES perfiles(id) ON DELETE RESTRICT,
  lote_id UUID REFERENCES lotes_creditos_estudios(id) ON DELETE SET NULL,

  tipo tipo_movimiento_creditos NOT NULL,
  cantidad INTEGER NOT NULL, -- positivo: compra/ajuste+; negativo: consumo/expiracion/ajuste-
  saldo_resultante INTEGER NOT NULL CHECK (saldo_resultante >= 0),

  expediente_id UUID REFERENCES expedientes(id) ON DELETE SET NULL,
  solicitante_id UUID REFERENCES solicitantes(id) ON DELETE SET NULL,
  pago_id UUID REFERENCES pagos(id) ON DELETE SET NULL,

  notas TEXT,
  usuario_id UUID REFERENCES perfiles(id),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_movimientos_creditos_perfil ON movimientos_creditos_estudios(perfil_id, created_at DESC);
CREATE INDEX idx_movimientos_creditos_expediente ON movimientos_creditos_estudios(expediente_id) WHERE expediente_id IS NOT NULL;

-- 6. Trigger para updated_at
CREATE OR REPLACE FUNCTION trg_creditos_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tg_paquetes_creditos_updated_at
  BEFORE UPDATE ON paquetes_creditos_estudios
  FOR EACH ROW EXECUTE FUNCTION trg_creditos_set_updated_at();

CREATE TRIGGER tg_compras_creditos_updated_at
  BEFORE UPDATE ON compras_creditos_estudios
  FOR EACH ROW EXECUTE FUNCTION trg_creditos_set_updated_at();

CREATE TRIGGER tg_lotes_creditos_updated_at
  BEFORE UPDATE ON lotes_creditos_estudios
  FOR EACH ROW EXECUTE FUNCTION trg_creditos_set_updated_at();

-- 7. RPC: consume_credito_estudio
-- Atomico: bloquea el lote FIFO mas antiguo no vencido con saldo,
-- decrementa cantidad_disponible, registra movimiento.
-- Devuelve el lote_id usado o lanza error si no hay saldo.
CREATE OR REPLACE FUNCTION consume_credito_estudio(
  p_perfil_id UUID,
  p_expediente_id UUID,
  p_solicitante_id UUID,
  p_pago_id UUID,
  p_usuario_id UUID,
  p_notas TEXT DEFAULT NULL
)
RETURNS TABLE(lote_id UUID, saldo_restante INTEGER) AS $$
DECLARE
  v_lote_id UUID;
  v_saldo INTEGER;
BEGIN
  -- 1. Encontrar lote FIFO mas antiguo, no vencido, con saldo, con lock
  SELECT id INTO v_lote_id
  FROM lotes_creditos_estudios
  WHERE perfil_id = p_perfil_id
    AND cantidad_disponible > 0
    AND (vence_en IS NULL OR vence_en > NOW())
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE;

  IF v_lote_id IS NULL THEN
    RAISE EXCEPTION 'SIN_SALDO_CREDITOS' USING ERRCODE = 'P0001';
  END IF;

  -- 2. Decrementar saldo del lote
  UPDATE lotes_creditos_estudios
  SET cantidad_disponible = cantidad_disponible - 1
  WHERE id = v_lote_id;

  -- 3. Calcular saldo total restante del perfil
  SELECT COALESCE(SUM(cantidad_disponible), 0) INTO v_saldo
  FROM lotes_creditos_estudios
  WHERE perfil_id = p_perfil_id
    AND (vence_en IS NULL OR vence_en > NOW());

  -- 4. Registrar movimiento
  INSERT INTO movimientos_creditos_estudios (
    perfil_id, lote_id, tipo, cantidad, saldo_resultante,
    expediente_id, solicitante_id, pago_id, usuario_id, notas
  ) VALUES (
    p_perfil_id, v_lote_id, 'consumo', -1, v_saldo,
    p_expediente_id, p_solicitante_id, p_pago_id, p_usuario_id, p_notas
  );

  RETURN QUERY SELECT v_lote_id, v_saldo;
END;
$$ LANGUAGE plpgsql;

-- 8. Seed: paquetes iniciales (precios confirmados por Mario)
INSERT INTO paquetes_creditos_estudios (nombre, descripcion, cantidad_estudios, precio_cop, vence_en_dias, activo, orden)
VALUES
  ('Paquete 5 estudios', '5 estudios de arrendamiento — $70.000 c/u', 5, 350000, NULL, TRUE, 1),
  ('Paquete 10 estudios', '10 estudios de arrendamiento — $64.000 c/u', 10, 640000, NULL, TRUE, 2),
  ('Paquete 25 estudios', '25 estudios de arrendamiento — $56.000 c/u', 25, 1400000, NULL, TRUE, 3);

COMMENT ON TABLE paquetes_creditos_estudios IS 'Catalogo de paquetes de creditos de estudios. Editable por super admin.';
COMMENT ON COLUMN paquetes_creditos_estudios.vence_en_dias IS 'Dias desde la compra hasta el vencimiento del lote. NULL = perpetuo.';
COMMENT ON TABLE compras_creditos_estudios IS 'Registro de compras de paquetes via Stripe Checkout.';
COMMENT ON TABLE lotes_creditos_estudios IS 'Lotes de creditos disponibles. Consumo FIFO. Cada compra genera un lote.';
COMMENT ON TABLE movimientos_creditos_estudios IS 'Bitacora de todas las operaciones sobre creditos (compra/consumo/expiracion/ajuste).';
