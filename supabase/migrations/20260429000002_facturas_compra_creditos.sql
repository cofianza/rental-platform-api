-- ============================================================
-- Migration: Permitir facturar compras de creditos de estudios
--
-- Hasta ahora la tabla facturas exigia expediente_id NOT NULL — toda
-- factura nacia de un pago de un expediente. La inmobiliaria ahora puede
-- facturar sus compras de paquetes de creditos, que NO estan atadas a un
-- expediente.
--
-- Cambios:
--   1. facturas.expediente_id pasa a NULLABLE.
--   2. Nueva FK opcional facturas.compra_creditos_id -> compras_creditos_estudios(id).
--   3. CHECK: una factura debe estar atada a un pago_id O a un compra_creditos_id
--      (no a ambos en NULL).
-- ============================================================

ALTER TABLE facturas
  ALTER COLUMN expediente_id DROP NOT NULL;

ALTER TABLE facturas
  ADD COLUMN IF NOT EXISTS compra_creditos_id UUID
    REFERENCES compras_creditos_estudios(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_facturas_compra_creditos
  ON facturas(compra_creditos_id)
  WHERE compra_creditos_id IS NOT NULL;

-- Garantia de integridad: cada factura debe nacer de un anchor (pago o
-- compra de creditos). Sin anchor no hay relacion con el sistema.
ALTER TABLE facturas
  ADD CONSTRAINT facturas_anchor_chk
    CHECK (pago_id IS NOT NULL OR compra_creditos_id IS NOT NULL);

COMMENT ON COLUMN facturas.compra_creditos_id IS
  'FK a compras_creditos_estudios cuando la factura corresponde a una compra de paquete de creditos (no a un pago de expediente).';
