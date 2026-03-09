-- ============================================================
-- HP-340: Almacenamiento seguro del contrato firmado
-- ============================================================

-- 1. Nuevas columnas en contratos para el PDF firmado
ALTER TABLE contratos
  ADD COLUMN IF NOT EXISTS firmado_storage_key TEXT,
  ADD COLUMN IF NOT EXISTS firmado_nombre_archivo TEXT,
  ADD COLUMN IF NOT EXISTS firmado_hash_integridad VARCHAR(64),
  ADD COLUMN IF NOT EXISTS firmado_ip VARCHAR(45),
  ADD COLUMN IF NOT EXISTS firmado_user_agent TEXT,
  ADD COLUMN IF NOT EXISTS firmado_referencia_otp TEXT,
  ADD COLUMN IF NOT EXISTS firmado_notas TEXT,
  ADD COLUMN IF NOT EXISTS firmado_tamano_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS firmado_subido_por UUID REFERENCES perfiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS firmado_subido_en TIMESTAMPTZ;

-- 2. Tabla de log de accesos al documento firmado
CREATE TABLE IF NOT EXISTS contrato_accesos_firmado (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contrato_id      UUID NOT NULL REFERENCES contratos(id) ON DELETE CASCADE,
  usuario_id       UUID REFERENCES perfiles(id) ON DELETE SET NULL,
  tipo_accion      VARCHAR(20) NOT NULL CHECK (tipo_accion IN ('descarga', 'visualizacion', 'verificacion')),
  ip               VARCHAR(45),
  user_agent       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contrato_accesos_contrato_id ON contrato_accesos_firmado(contrato_id);
CREATE INDEX IF NOT EXISTS idx_contrato_accesos_usuario_id ON contrato_accesos_firmado(usuario_id);
