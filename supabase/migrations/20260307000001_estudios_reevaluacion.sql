-- Re-evaluacion de estudios de riesgo crediticio
-- Permite vincular un nuevo estudio al original cuando el resultado es rechazado o condicionado

ALTER TABLE estudios
  ADD COLUMN estudio_padre_id UUID REFERENCES estudios(id) ON DELETE SET NULL;

CREATE INDEX idx_estudios_padre_id ON estudios(estudio_padre_id)
  WHERE estudio_padre_id IS NOT NULL;

CREATE TABLE estudios_documentos_soporte (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  estudio_id       UUID NOT NULL REFERENCES estudios(id) ON DELETE CASCADE,
  storage_key      TEXT NOT NULL,
  nombre_original  VARCHAR(255) NOT NULL,
  tipo_mime        VARCHAR(100) NOT NULL,
  tamano_bytes     INTEGER NOT NULL,
  proposito        VARCHAR(100) NOT NULL
                     CHECK (proposito IN (
                       'certificacion_laboral','extractos_bancarios',
                       'declaracion_renta','carta_referencia','otros_soportes'
                     )),
  subido_por       UUID REFERENCES perfiles(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_estudios_docs_soporte_estudio_id
  ON estudios_documentos_soporte(estudio_id);
