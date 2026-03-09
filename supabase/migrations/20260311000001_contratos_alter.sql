-- ============================================================
-- Generacion de Contratos PDF — ALTER TABLE contratos
-- ============================================================

-- Nuevas columnas para generacion de contratos
ALTER TABLE contratos
  ADD COLUMN datos_variables    JSONB,
  ADD COLUMN generado_por       UUID REFERENCES perfiles(id) ON DELETE SET NULL,
  ADD COLUMN fecha_generacion   TIMESTAMPTZ,
  ADD COLUMN storage_key        TEXT,
  ADD COLUMN nombre_archivo     TEXT,
  ADD COLUMN plantilla_version  SMALLINT;

-- Renombrar contenido_url a contenido_pdf_url (claridad)
ALTER TABLE contratos RENAME COLUMN contenido_url TO contenido_pdf_url;

-- Indices
CREATE INDEX IF NOT EXISTS idx_contratos_expediente_id ON contratos(expediente_id);
CREATE INDEX IF NOT EXISTS idx_contratos_generado_por  ON contratos(generado_por);
CREATE INDEX IF NOT EXISTS idx_contratos_estado        ON contratos(estado);
