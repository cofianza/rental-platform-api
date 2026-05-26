-- ============================================================
-- Módulo de Moras — Mario 12-may-2026, mockup 13_*propietario.html
--
-- Flujo automático de 3 fases:
--   Fase 1 (Recordatorio):   t=0       — al reportar, WhatsApp amistoso
--   Fase 2 (Urgencia):       t+4 días  — escalado, involucra coarrendatario
--   Fase 3 (Legal):          t+10 días — Cofianza toma control y paga al
--                                        arrendador vía póliza
--
-- Termina en `pagada` (inquilino pagó) o `cancelada` (reporte erróneo /
-- acuerdo extra-judicial). Las fechas de escalado quedan persistidas para
-- el timeline.
-- ============================================================

-- Estado del ticket (state machine)
DO $$ BEGIN
  CREATE TYPE mora_estado AS ENUM ('fase_1', 'fase_2', 'fase_3', 'pagada', 'cancelada');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Quien escribió un mensaje en el chat de la mora
DO $$ BEGIN
  CREATE TYPE mora_mensaje_autor AS ENUM ('sistema', 'asesor', 'inquilino', 'propietario');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Secuencia + función para generar ticket_numero estilo "MOR-2026-001"
CREATE SEQUENCE IF NOT EXISTS moras_ticket_seq START 1;

CREATE OR REPLACE FUNCTION generar_ticket_mora_numero() RETURNS VARCHAR AS $$
DECLARE
  seq_val BIGINT;
  yr INTEGER;
BEGIN
  seq_val := nextval('moras_ticket_seq');
  yr := EXTRACT(YEAR FROM NOW())::INTEGER;
  RETURN 'MOR-' || yr || '-' || LPAD(seq_val::TEXT, 3, '0');
END;
$$ LANGUAGE plpgsql;

-- Tabla principal
CREATE TABLE IF NOT EXISTS moras_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_numero VARCHAR(30) UNIQUE NOT NULL DEFAULT generar_ticket_mora_numero(),

  -- Vínculos al contrato / expediente / partes (snapshot para que el ticket
  -- sobreviva aunque luego se modifique el contrato).
  contrato_id UUID REFERENCES contratos(id) ON DELETE CASCADE NOT NULL,
  expediente_id UUID REFERENCES expedientes(id) ON DELETE SET NULL,
  solicitante_id UUID REFERENCES solicitantes(id) ON DELETE SET NULL,

  -- Snapshot del inquilino al momento del reporte
  inquilino_nombre VARCHAR(200) NOT NULL,
  inquilino_telefono VARCHAR(20),
  inquilino_email VARCHAR(200),

  -- Snapshot del inmueble
  inmueble_codigo VARCHAR(30),
  inmueble_direccion VARCHAR(300),

  -- Coarrendatario (opcional)
  coarrendatario_id UUID,
  coarrendatario_nombre VARCHAR(200),

  -- Datos económicos
  monto_mora INTEGER NOT NULL CHECK (monto_mora >= 0),
  fecha_vencimiento_canon DATE NOT NULL,

  -- Estado + workflow
  estado mora_estado NOT NULL DEFAULT 'fase_1',
  reportado_por UUID REFERENCES perfiles(id) NOT NULL,
  reportado_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  descripcion TEXT,

  -- Timestamps de cada escalado (para el timeline)
  fase_2_at TIMESTAMPTZ,
  fase_3_at TIMESTAMPTZ,
  pagada_at TIMESTAMPTZ,
  cancelada_at TIMESTAMPTZ,
  cancelado_motivo TEXT,

  -- Auditoría
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS moras_tickets_contrato_idx ON moras_tickets(contrato_id);
CREATE INDEX IF NOT EXISTS moras_tickets_estado_idx ON moras_tickets(estado);
CREATE INDEX IF NOT EXISTS moras_tickets_reportado_por_idx ON moras_tickets(reportado_por);
CREATE INDEX IF NOT EXISTS moras_tickets_reportado_at_idx ON moras_tickets(reportado_at DESC);

-- Trigger para updated_at
CREATE OR REPLACE FUNCTION moras_tickets_set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS moras_tickets_updated_at ON moras_tickets;
CREATE TRIGGER moras_tickets_updated_at
  BEFORE UPDATE ON moras_tickets
  FOR EACH ROW EXECUTE FUNCTION moras_tickets_set_updated_at();

-- Chat / mensajes asociados al ticket
CREATE TABLE IF NOT EXISTS moras_mensajes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mora_id UUID REFERENCES moras_tickets(id) ON DELETE CASCADE NOT NULL,
  autor_tipo mora_mensaje_autor NOT NULL,
  autor_id UUID REFERENCES perfiles(id),  -- NULL para 'sistema' e 'inquilino' (este último no tiene cuenta)
  mensaje TEXT NOT NULL,
  via_whatsapp BOOLEAN DEFAULT false,
  whatsapp_message_id VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS moras_mensajes_mora_idx ON moras_mensajes(mora_id, created_at);

COMMENT ON TABLE moras_tickets IS 'Tickets de mora — flujo 3 fases (Mario 12-may-2026).';
COMMENT ON TABLE moras_mensajes IS 'Mensajes del chat de seguimiento por ticket de mora.';
COMMENT ON COLUMN moras_tickets.ticket_numero IS 'Identificador legible MOR-<año>-<secuencial>.';
COMMENT ON COLUMN moras_tickets.fase_2_at IS 'Cuándo escaló a Fase 2 (Urgencia, +4d).';
COMMENT ON COLUMN moras_tickets.fase_3_at IS 'Cuándo escaló a Fase 3 (Legal, +10d).';
