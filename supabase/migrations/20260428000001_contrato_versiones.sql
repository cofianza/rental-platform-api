-- ============================================================
-- contrato_versiones: snapshots historicos de cada version del PDF.
--
-- Cuando se regenera un contrato (POST /contratos/:id/regenerar) o se
-- crea una renovacion, archivamos la version actual aqui antes de
-- sobreescribir storage_key/datos_variables. Esto permite ver el
-- historial completo y comparar versiones.
--
-- El codigo en src/modules/contratos/contratos.service.ts ya referencia
-- esta tabla (archiveCurrentVersion, listVersionesByContrato, etc.)
-- pero la migracion correspondiente no estaba aplicada.
-- ============================================================

CREATE TABLE IF NOT EXISTS contrato_versiones (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contrato_id        UUID NOT NULL REFERENCES contratos(id) ON DELETE CASCADE,
  version            SMALLINT NOT NULL,
  datos_variables    JSONB,
  storage_key        TEXT NOT NULL,
  nombre_archivo     TEXT,
  plantilla_version  SMALLINT,
  generado_por       UUID REFERENCES perfiles(id),
  fecha_generacion   TIMESTAMPTZ,
  resumen_cambios    TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_contrato_version UNIQUE (contrato_id, version)
);

CREATE INDEX IF NOT EXISTS idx_contrato_versiones_contrato
  ON contrato_versiones(contrato_id);

CREATE INDEX IF NOT EXISTS idx_contrato_versiones_created
  ON contrato_versiones(created_at DESC);

COMMENT ON TABLE contrato_versiones IS 'Historial de versiones del PDF de cada contrato. Cada regenerar/renovar archiva la version anterior aqui antes de sobreescribir el actual.';
COMMENT ON COLUMN contrato_versiones.resumen_cambios IS 'Texto humano explicando que cambio respecto a la version anterior (ej. "Se actualizaron datos del propietario").';
