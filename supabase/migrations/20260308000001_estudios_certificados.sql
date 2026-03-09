-- ============================================
-- HP: Certificados de Estudios de Riesgo Crediticio
-- Tabla para almacenar metadata de certificados PDF generados
-- ============================================

CREATE TABLE estudios_certificados (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  estudio_id        UUID NOT NULL REFERENCES estudios(id) ON DELETE CASCADE,
  codigo            VARCHAR(20) NOT NULL,
  pdf_storage_key   TEXT NOT NULL,
  fecha_emision     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fecha_vencimiento TIMESTAMPTZ NOT NULL,
  emitido_por       UUID REFERENCES perfiles(id) ON DELETE SET NULL,
  version           INTEGER NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_estudios_certificados_estudio UNIQUE (estudio_id),
  CONSTRAINT uq_estudios_certificados_codigo UNIQUE (codigo)
);

CREATE INDEX idx_estudios_certificados_codigo ON estudios_certificados(codigo);
