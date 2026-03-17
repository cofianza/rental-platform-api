-- ============================================================
-- Migration: Add comprobante file fields and referencia_bancaria to pagos
-- HP-350: Manual payment registration with comprobante upload
-- ============================================================

ALTER TABLE pagos ADD COLUMN IF NOT EXISTS comprobante_storage_key VARCHAR(500);
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS comprobante_nombre_original VARCHAR(255);
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS comprobante_tipo_mime VARCHAR(100);
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS comprobante_tamano_bytes INTEGER;
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS referencia_bancaria VARCHAR(255);
