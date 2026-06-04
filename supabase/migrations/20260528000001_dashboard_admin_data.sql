-- ============================================================
-- Dashboard admin — datos faltantes (Mario 28-may-2026).
--
-- Cierra los 4 KPIs que estaban como "sin data" en el Centro de Control:
--   1. Capital libre / reserva   → claves en configuracion_sistema
--   2. Desembolsos a propietarios → columnas en moras_tickets
--   3. Tickets de soporte         → tabla nueva tickets_soporte
--   4. Visitas a vitrina pública  → tabla nueva vitrina_interacciones
-- ============================================================

-- ─── 1. Tesorería: claves en configuracion_sistema ──────────
--
-- Solo agregamos las claves si no existen. El admin las edita después.
-- Defaults conservadores (0) para que el dashboard no calcule alertas
-- de "capital insuficiente" antes de que se configure la cifra real.
INSERT INTO configuracion_sistema (clave, valor, tipo, descripcion)
VALUES
  ('tesoreria_capital_disponible', '0', 'number', 'Capital total disponible de Cofianza para cubrir siniestros. Editar desde /configuracion.'),
  ('tesoreria_reserva_minima', '0', 'number', 'Reserva mínima a mantener intocable. Capital libre = capital_disponible - reserva_minima.')
ON CONFLICT (clave) DO NOTHING;

-- ─── 2. moras_tickets: pago de Cofianza al propietario ──────
--
-- Cuando una mora escala a fase 3 (legal), Cofianza paga al propietario
-- la cuota cubierta por la póliza de afianzamiento. Estos campos
-- registran ese desembolso para reportarlo en el dashboard.
ALTER TABLE moras_tickets
  ADD COLUMN IF NOT EXISTS cofianza_pago_realizado BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cofianza_pago_monto INTEGER CHECK (cofianza_pago_monto IS NULL OR cofianza_pago_monto >= 0),
  ADD COLUMN IF NOT EXISTS cofianza_pago_fecha TIMESTAMPTZ;

COMMENT ON COLUMN moras_tickets.cofianza_pago_realizado IS 'true si Cofianza ya desembolsó al propietario por esta mora.';
COMMENT ON COLUMN moras_tickets.cofianza_pago_monto IS 'Monto desembolsado por Cofianza al propietario (en pesos).';
COMMENT ON COLUMN moras_tickets.cofianza_pago_fecha IS 'Fecha en que Cofianza realizó el desembolso.';

CREATE INDEX IF NOT EXISTS moras_tickets_cofianza_pago_idx
  ON moras_tickets(cofianza_pago_realizado)
  WHERE cofianza_pago_realizado = true;

-- ─── 3. Tickets de soporte ──────────────────────────────────
--
-- Módulo separado de moras: incidencias funcionales (consultas, bugs,
-- gestiones operativas) reportadas por usuarios autenticados.
DO $$ BEGIN
  CREATE TYPE ticket_soporte_prioridad AS ENUM ('alta', 'media', 'baja');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE ticket_soporte_estado AS ENUM ('abierto', 'en_proceso', 'resuelto');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE SEQUENCE IF NOT EXISTS tickets_soporte_seq START 1;

CREATE OR REPLACE FUNCTION generar_ticket_soporte_numero() RETURNS VARCHAR AS $$
DECLARE
  seq_val BIGINT;
  yr INTEGER;
BEGIN
  seq_val := nextval('tickets_soporte_seq');
  yr := EXTRACT(YEAR FROM NOW())::INTEGER;
  RETURN 'SOP-' || yr || '-' || LPAD(seq_val::TEXT, 3, '0');
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS tickets_soporte (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_numero VARCHAR(30) UNIQUE NOT NULL DEFAULT generar_ticket_soporte_numero(),

  remitente_id UUID NOT NULL REFERENCES perfiles(id),
  asignado_a UUID REFERENCES perfiles(id),

  tipo VARCHAR(50) NOT NULL,
  asunto VARCHAR(300) NOT NULL,
  descripcion TEXT,

  prioridad ticket_soporte_prioridad NOT NULL DEFAULT 'media',
  estado ticket_soporte_estado NOT NULL DEFAULT 'abierto',

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS tickets_soporte_estado_idx ON tickets_soporte(estado);
CREATE INDEX IF NOT EXISTS tickets_soporte_remitente_idx ON tickets_soporte(remitente_id);
CREATE INDEX IF NOT EXISTS tickets_soporte_created_at_idx ON tickets_soporte(created_at DESC);

CREATE OR REPLACE FUNCTION tickets_soporte_set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  IF NEW.estado = 'resuelto' AND OLD.estado <> 'resuelto' THEN
    NEW.resolved_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tickets_soporte_updated_at ON tickets_soporte;
CREATE TRIGGER tickets_soporte_updated_at
  BEFORE UPDATE ON tickets_soporte
  FOR EACH ROW EXECUTE FUNCTION tickets_soporte_set_updated_at();

COMMENT ON TABLE tickets_soporte IS 'Tickets de soporte funcional (separado de moras_tickets).';

-- ─── 4. Visitas a la vitrina pública ────────────────────────
--
-- Tracking minimal de interacciones con inmuebles publicados. Sin user_id
-- (la vitrina es pública). Tipo "vista" se registra al cargar el detalle;
-- "contacto" se reservaría para clicks en WhatsApp/teléfono (futuro).
CREATE TABLE IF NOT EXISTS vitrina_interacciones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inmueble_id UUID NOT NULL REFERENCES inmuebles(id) ON DELETE CASCADE,
  tipo VARCHAR(15) NOT NULL DEFAULT 'vista'
    CHECK (tipo IN ('vista', 'contacto')),
  ip VARCHAR(45),
  user_agent VARCHAR(500),
  referrer VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS vitrina_interacciones_inmueble_idx ON vitrina_interacciones(inmueble_id);
CREATE INDEX IF NOT EXISTS vitrina_interacciones_created_at_idx ON vitrina_interacciones(created_at DESC);
CREATE INDEX IF NOT EXISTS vitrina_interacciones_tipo_idx ON vitrina_interacciones(tipo);

COMMENT ON TABLE vitrina_interacciones IS 'Tracking anónimo de visitas y contactos en la vitrina pública.';
