-- ============================================================
-- HP-341: Integracion con Auco.ai para firma electronica
-- ============================================================

-- Codigo del documento en Auco para tracking
ALTER TABLE solicitudes_firma
  ADD COLUMN IF NOT EXISTS auco_document_code VARCHAR(50),
  ADD COLUMN IF NOT EXISTS auco_signed_url TEXT;

CREATE INDEX IF NOT EXISTS idx_solicitudes_firma_auco_code
  ON solicitudes_firma(auco_document_code)
  WHERE auco_document_code IS NOT NULL;
