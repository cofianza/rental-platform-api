-- ============================================================
-- HP-340 D1: Archivos asociados al contrato
-- Tabla generica para inventario, acta de entrega, documentos de identidad
-- ============================================================

CREATE TABLE IF NOT EXISTS contrato_archivos (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contrato_id      UUID NOT NULL REFERENCES contratos(id) ON DELETE CASCADE,
  tipo_archivo     VARCHAR(30) NOT NULL CHECK (tipo_archivo IN ('inventario', 'acta_entrega', 'documento_identidad')),
  storage_key      TEXT NOT NULL,
  nombre_archivo   TEXT NOT NULL,
  tipo_mime        VARCHAR(100) NOT NULL,
  tamano_bytes     BIGINT NOT NULL,
  hash_integridad  VARCHAR(64) NOT NULL,
  subido_por       UUID REFERENCES perfiles(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contrato_archivos_contrato_id ON contrato_archivos(contrato_id);
CREATE INDEX IF NOT EXISTS idx_contrato_archivos_tipo ON contrato_archivos(contrato_id, tipo_archivo);

-- Fix: agregar 'subida' al CHECK constraint de contrato_accesos_firmado
ALTER TABLE contrato_accesos_firmado
  DROP CONSTRAINT IF EXISTS contrato_accesos_firmado_tipo_accion_check;
ALTER TABLE contrato_accesos_firmado
  ADD CONSTRAINT contrato_accesos_firmado_tipo_accion_check
  CHECK (tipo_accion IN ('descarga', 'visualizacion', 'verificacion', 'subida'));
