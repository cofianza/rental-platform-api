-- ============================================================
-- Documentos legales de inmobiliaria/propietario (Mario 12-may-2026).
--
-- Cada inmobiliaria tiene que cargar 7 documentos legales para operar
-- con Cofianza (camara de comercio, RUT, matricula de arrendador,
-- cedula del representante legal, poder notarial opcional, poliza de
-- seguros y contrato marco con Cofianza). El propietario individual
-- usa un subset (cedula + RUT principalmente).
--
-- Modelo: tabla aparte de `perfiles`. Razones:
--   - Cada doc tiene su propio storage_key + metadata + estado.
--   - Permite historial: al reemplazar guardamos audit en bitacora.
--   - Una UNIQUE(perfil_id, tipo) garantiza un solo doc activo por
--     tipo (el upload pisa el anterior via UPSERT).
-- ============================================================

CREATE TYPE tipo_documento_legal AS ENUM (
  'camara_comercio',
  'rut',
  'matricula_arrendador',
  'cedula_representante',
  'poder_notarial',
  'poliza',
  'contrato_marco'
);

CREATE TYPE estado_documento_legal AS ENUM (
  'cargado',
  'validado',
  'rechazado'
);

CREATE TABLE public.documentos_legales_inmobiliaria (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  perfil_id       UUID NOT NULL REFERENCES public.perfiles(id) ON DELETE CASCADE,
  tipo            tipo_documento_legal NOT NULL,
  storage_key     TEXT NOT NULL,
  nombre_archivo  VARCHAR(255) NOT NULL,
  tipo_mime       VARCHAR(100) NOT NULL,
  tamano_bytes    BIGINT NOT NULL CHECK (tamano_bytes > 0),
  estado          estado_documento_legal NOT NULL DEFAULT 'cargado',
  notas_validacion TEXT,
  subido_por      UUID REFERENCES public.perfiles(id) ON DELETE SET NULL,
  subido_en       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  validado_por    UUID REFERENCES public.perfiles(id) ON DELETE SET NULL,
  validado_en     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT documentos_legales_inmobiliaria_unique_por_tipo
    UNIQUE (perfil_id, tipo)
);

CREATE INDEX idx_documentos_legales_perfil
  ON public.documentos_legales_inmobiliaria (perfil_id);

CREATE TRIGGER documentos_legales_updated_at
  BEFORE UPDATE ON public.documentos_legales_inmobiliaria
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE public.documentos_legales_inmobiliaria IS
  'Documentos legales que la inmobiliaria/propietario sube para operar con Cofianza (Camara de Comercio, RUT, Matricula de Arrendador, Cedula RL, Poder, Poliza, Contrato Marco). UNIQUE(perfil_id, tipo) garantiza un doc por tipo.';
