-- ============================================================
-- HP-343: Tabla codigos_otp para verificacion en firma electronica
-- ============================================================

CREATE TABLE codigos_otp (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  solicitud_firma_id UUID NOT NULL REFERENCES solicitudes_firma(id) ON DELETE CASCADE,
  codigo_hash VARCHAR(64) NOT NULL,
  canal VARCHAR(10) NOT NULL CHECK (canal IN ('email', 'sms')),
  expiracion TIMESTAMPTZ NOT NULL,
  intentos_realizados INT NOT NULL DEFAULT 0,
  max_intentos INT NOT NULL DEFAULT 3,
  verificado_en TIMESTAMPTZ,
  invalidado BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indices
CREATE INDEX idx_codigos_otp_solicitud ON codigos_otp(solicitud_firma_id);
CREATE INDEX idx_codigos_otp_activo ON codigos_otp(solicitud_firma_id)
  WHERE verificado_en IS NULL AND invalidado = FALSE;
