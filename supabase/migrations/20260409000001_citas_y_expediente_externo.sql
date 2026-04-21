-- ============================================================
-- Migración: Citas de visita + campos expediente externo
-- Fecha: 2026-04-09
-- Descripción: Crea la tabla de citas para agendar visitas a
--   inmuebles y agrega columnas al expediente para el flujo
--   de invitación externa (token, email, habilitación estudio).
-- ============================================================

-- ============================================================
-- 1. TIPO ENUMERADO
-- ============================================================

-- Estados posibles de una cita de visita
CREATE TYPE estado_cita AS ENUM (
  'solicitada',
  'confirmada',
  'realizada',
  'cancelada',
  'no_asistio'
);

-- ============================================================
-- 2. TABLA CITAS
-- ============================================================

CREATE TABLE IF NOT EXISTS citas (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expediente_id        UUID NOT NULL REFERENCES expedientes(id) ON DELETE CASCADE,
  fecha_propuesta      TIMESTAMPTZ,          -- fecha/hora propuesta por el solicitante
  fecha_confirmada     TIMESTAMPTZ,          -- fecha/hora confirmada por propietario/agencia
  estado               estado_cita NOT NULL DEFAULT 'solicitada',
  notas_solicitante    TEXT,                 -- notas del solicitante al solicitar la cita
  notas_propietario    TEXT,                 -- notas del propietario/agencia al confirmar
  motivo_cancelacion   TEXT,                 -- razón de cancelación (si aplica)
  creado_por           UUID REFERENCES perfiles(id),   -- usuario que creó la cita
  confirmado_por       UUID REFERENCES perfiles(id),   -- usuario que confirmó la cita
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices para consultas frecuentes
CREATE INDEX IF NOT EXISTS idx_citas_expediente ON citas(expediente_id);
CREATE INDEX IF NOT EXISTS idx_citas_estado ON citas(estado);
CREATE INDEX IF NOT EXISTS idx_citas_fecha_propuesta ON citas(fecha_propuesta);

-- Trigger para actualizar updated_at automáticamente
CREATE TRIGGER trg_citas_updated_at
  BEFORE UPDATE ON citas
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- 3. COLUMNAS NUEVAS EN EXPEDIENTES
-- ============================================================

-- Habilita el estudio crediticio para este expediente
ALTER TABLE expedientes
  ADD COLUMN IF NOT EXISTS estudio_habilitado BOOLEAN DEFAULT FALSE;

-- Token único de invitación para el flujo de expediente externo
ALTER TABLE expedientes
  ADD COLUMN IF NOT EXISTS token_invitacion VARCHAR UNIQUE;

-- Email del cliente invitado (flujo externo)
ALTER TABLE expedientes
  ADD COLUMN IF NOT EXISTS email_invitacion VARCHAR;

-- Permitir solicitante_id NULL para expedientes externos pendientes de vincular
ALTER TABLE expedientes
  ALTER COLUMN solicitante_id DROP NOT NULL;

COMMENT ON COLUMN expedientes.estudio_habilitado IS 'Indica si el estudio crediticio está habilitado para este expediente';
COMMENT ON COLUMN expedientes.token_invitacion IS 'Token único para el flujo de expediente externo (invitación)';
COMMENT ON COLUMN expedientes.email_invitacion IS 'Email del cliente invitado por enlace externo';

-- ============================================================
-- 4. ENUM tipo_evento_timeline: agregar valor 'cita'
-- ============================================================

ALTER TYPE tipo_evento_timeline ADD VALUE IF NOT EXISTS 'cita';

-- ============================================================
-- 5. ROW LEVEL SECURITY
-- ============================================================

-- Habilitar RLS en citas. Sin políticas explícitas, solo service_role
-- (que omite RLS) puede acceder. Políticas granulares se agregan después.
ALTER TABLE citas ENABLE ROW LEVEL SECURITY;
