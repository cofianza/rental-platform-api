-- ============================================================
-- HP-334: Firma digital de autorizacion habeas data
-- Agrega columnas de firma + tabla de OTPs
-- ============================================================

-- 1. Nuevas columnas en autorizaciones_habeas_data
ALTER TABLE autorizaciones_habeas_data
  ADD COLUMN expediente_id UUID REFERENCES expedientes(id),
  ADD COLUMN metodo_firma VARCHAR(10) CHECK (metodo_firma IN ('canvas', 'otp')),
  ADD COLUMN datos_firma TEXT,
  ADD COLUMN referencia_otp VARCHAR(100),
  ADD COLUMN hash_documento VARCHAR(64),
  ADD COLUMN fecha_revocacion TIMESTAMPTZ,
  ADD COLUMN motivo_revocacion TEXT;

CREATE INDEX idx_autorizaciones_expediente
  ON autorizaciones_habeas_data(expediente_id);

-- 2. Tabla de codigos OTP para verificacion
CREATE TABLE autorizacion_otps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  autorizacion_id UUID NOT NULL REFERENCES autorizaciones_habeas_data(id) ON DELETE CASCADE,
  codigo VARCHAR(6) NOT NULL,
  expira_en TIMESTAMPTZ NOT NULL,
  verificado BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_autorizacion_otps_autorizacion
  ON autorizacion_otps(autorizacion_id);
