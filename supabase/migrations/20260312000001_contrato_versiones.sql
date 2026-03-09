-- ============================================================
-- Contrato Versiones — Version history archive
-- ============================================================

CREATE TABLE contrato_versiones (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contrato_id       UUID NOT NULL REFERENCES contratos(id) ON DELETE CASCADE,
  version           SMALLINT NOT NULL,
  datos_variables   JSONB,
  storage_key       TEXT NOT NULL,
  nombre_archivo    TEXT,
  plantilla_version SMALLINT,
  generado_por      UUID REFERENCES perfiles(id) ON DELETE SET NULL,
  fecha_generacion  TIMESTAMPTZ,
  resumen_cambios   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_contrato_versiones UNIQUE (contrato_id, version)
);

CREATE INDEX idx_contrato_versiones_contrato_id ON contrato_versiones(contrato_id);
