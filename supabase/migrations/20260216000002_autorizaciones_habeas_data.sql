-- ============================================================
-- Cofianza 2.0 - Migración: Autorizaciones Habeas Data
-- Fecha: 2026-02-16
-- Contexto: Minuta 11 Feb 2026 - Sección 5.1
-- Cumplimiento: Ley 1581/2012 (Protección de datos personales)
--               Ley 1266/2008 (Habeas data financiero)
-- ============================================================

-- ============================================================
-- 1. NUEVOS TIPOS ENUMERADOS
-- ============================================================

-- Canal por el cual se obtuvo la autorización
CREATE TYPE canal_autorizacion_habeas AS ENUM (
  'web',       -- Usuario se registró por la web y aceptó durante el registro
  'enlace'     -- Admin generó un enlace único, cliente firmó digitalmente
);

-- Estado de la autorización
CREATE TYPE estado_autorizacion_habeas AS ENUM (
  'pendiente',   -- Enlace generado pero no firmado aún (solo para canal 'enlace')
  'autorizado',  -- Cliente aceptó/firmó la autorización
  'expirado',    -- Enlace expiró sin ser firmado
  'revocado'     -- Cliente revocó su autorización (derecho legal colombiano)
);

-- ============================================================
-- 2. NUEVA TABLA: autorizaciones_habeas_data
-- ============================================================

CREATE TABLE autorizaciones_habeas_data (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  solicitante_id    UUID NOT NULL REFERENCES solicitantes(id),
  canal             canal_autorizacion_habeas NOT NULL,
  estado            estado_autorizacion_habeas NOT NULL DEFAULT 'pendiente',
  token             VARCHAR(255) UNIQUE,
  token_expiracion  TIMESTAMPTZ,
  generado_por      UUID REFERENCES perfiles(id),
  autorizado_en     TIMESTAMPTZ,
  ip_autorizacion   VARCHAR(45),
  user_agent        TEXT,
  texto_autorizado  TEXT,
  version_terminos  VARCHAR(50),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 3. ÍNDICES
-- ============================================================

CREATE INDEX idx_autorizaciones_solicitante ON autorizaciones_habeas_data(solicitante_id);
CREATE INDEX idx_autorizaciones_token ON autorizaciones_habeas_data(token) WHERE token IS NOT NULL;
CREATE INDEX idx_autorizaciones_estado ON autorizaciones_habeas_data(estado);

-- ============================================================
-- 4. RLS
-- ============================================================

ALTER TABLE autorizaciones_habeas_data ENABLE ROW LEVEL SECURITY;

-- Sin políticas temporales: con RLS habilitado y sin políticas,
-- solo service_role (que omite RLS) puede acceder a los datos.
-- Las políticas granulares por rol se implementan en HP-30.

-- ============================================================
-- 5. MODIFICAR TABLA estudios: agregar FK a autorización
-- ============================================================

ALTER TABLE estudios
  ADD COLUMN autorizacion_habeas_data_id UUID REFERENCES autorizaciones_habeas_data(id);

CREATE INDEX idx_estudios_autorizacion ON estudios(autorizacion_habeas_data_id)
  WHERE autorizacion_habeas_data_id IS NOT NULL;

-- ============================================================
-- 6. AGREGAR VALOR AL ENUM tipo_evento_timeline
-- ============================================================

ALTER TYPE tipo_evento_timeline ADD VALUE 'autorizacion';
