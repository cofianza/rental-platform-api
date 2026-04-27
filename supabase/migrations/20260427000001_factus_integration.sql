-- ============================================================
-- Integración Factus (facturación electrónica DIAN)
--
-- 1. Solicitantes: agrega municipio (Factus exige municipality_id para crear
--    facturas a clientes en Colombia).
-- 2. Facturas: agrega columnas para guardar la respuesta de Factus (CUFE,
--    QR, PDF/XML URLs, payload crudo) y un nuevo estado intermedio.
-- ============================================================

-- ── Solicitantes: municipio para facturación ──────────────────────
ALTER TABLE solicitantes
  ADD COLUMN IF NOT EXISTS municipio_id INT,
  ADD COLUMN IF NOT EXISTS municipio_nombre TEXT;

COMMENT ON COLUMN solicitantes.municipio_id IS 'ID Factus del municipio (catalogo de Factus, no DANE). Requerido para crear factura electronica.';
COMMENT ON COLUMN solicitantes.municipio_nombre IS 'Nombre del municipio (cache para mostrar sin re-llamar a Factus).';

-- ── Facturas: integración Factus ──────────────────────────────────
-- Estados ampliados: pendiente (aun no enviada) -> emitida (validada DIAN) -> ...
-- Mantenemos compatibilidad con el enum existente.
ALTER TABLE facturas
  ADD COLUMN IF NOT EXISTS factus_bill_id BIGINT,
  ADD COLUMN IF NOT EXISTS factus_reference_code TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS factus_number TEXT,
  ADD COLUMN IF NOT EXISTS cufe TEXT,
  ADD COLUMN IF NOT EXISTS qr_url TEXT,
  ADD COLUMN IF NOT EXISTS qr_image_base64 TEXT,
  ADD COLUMN IF NOT EXISTS pdf_url TEXT,
  ADD COLUMN IF NOT EXISTS xml_url TEXT,
  ADD COLUMN IF NOT EXISTS respuesta_proveedor JSONB,
  ADD COLUMN IF NOT EXISTS concepto TEXT,
  ADD COLUMN IF NOT EXISTS total NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS error_mensaje TEXT,
  ADD COLUMN IF NOT EXISTS validada_en TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_facturas_factus_number ON facturas(factus_number);
CREATE INDEX IF NOT EXISTS idx_facturas_cufe ON facturas(cufe);

COMMENT ON COLUMN facturas.factus_bill_id IS 'ID interno de Factus (campo bill.id en su respuesta).';
COMMENT ON COLUMN facturas.factus_reference_code IS 'Código único nuestro enviado a Factus para idempotencia (ej. EXP-2026-0014-PAGO-{pago_id_short}).';
COMMENT ON COLUMN facturas.factus_number IS 'Número oficial DIAN devuelto por Factus (ej. SETP990000493).';
COMMENT ON COLUMN facturas.cufe IS 'Código Único de Factura Electrónica — identificador DIAN.';
COMMENT ON COLUMN facturas.respuesta_proveedor IS 'Snapshot completo de la respuesta de Factus, para auditoría.';
COMMENT ON COLUMN facturas.error_mensaje IS 'Si el envío a Factus falla, mensaje de error para debug + retry manual.';
