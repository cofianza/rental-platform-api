-- ============================================================
-- HP-344: Tabla evidencias_firma para recoleccion de evidencia legal
-- Relacion 1:1 con solicitudes_firma
-- ============================================================

CREATE TABLE evidencias_firma (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  solicitud_firma_id UUID NOT NULL UNIQUE REFERENCES solicitudes_firma(id) ON DELETE CASCADE,
  ip_firmante VARCHAR(45) NOT NULL,
  user_agent TEXT NOT NULL,
  geo_latitud DOUBLE PRECISION,
  geo_longitud DOUBLE PRECISION,
  geo_precision DOUBLE PRECISION,
  otp_verificado_en TIMESTAMPTZ NOT NULL,
  firma_imagen_key TEXT NOT NULL,
  firmado_en TIMESTAMPTZ NOT NULL,
  hash_documento VARCHAR(64) NOT NULL,
  acuse_storage_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_evidencias_firma_solicitud ON evidencias_firma(solicitud_firma_id);
