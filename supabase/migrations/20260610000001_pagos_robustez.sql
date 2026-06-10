-- ============================================================
-- Robustez de pagos (auditoría 2026-06-09, Tanda 1):
--   1. Índice único parcial: UN solo pago de estudio "activo" por expediente.
--      Cierra las carreras enviarLinkPago×2, liberarCredito×2, asumir×link, y
--      evita que el webhook complete un segundo pago de estudio.
--   2. Índice único en lotes_creditos_estudios.compra_id: hace idempotente la
--      acreditación de compras (retries del webhook de MP no duplican créditos).
--   3. Tabla pagos_no_conciliados: dinero recibido en la pasarela que no se
--      pudo casar con un pago en BD (link cancelado pagado, monto distinto,
--      referencia desconocida). Hoy ese dinero se pierde en un log.warn.
-- ============================================================

-- 1a. Sanear duplicados previos: si un expediente tiene varios pagos de estudio
--     activos, cancelar los pendientes/procesando que tengan otro más reciente
--     (el más nuevo o el completado sobrevive). Sin esto el CREATE INDEX falla.
UPDATE pagos p
SET estado = 'cancelado', updated_at = now(),
    notas = COALESCE(p.notas || ' | ', '') || 'Cancelado por saneo de duplicados (migracion 20260610000001)'
WHERE p.concepto = 'estudio'
  AND p.estado IN ('pendiente', 'procesando')
  AND EXISTS (
    SELECT 1 FROM pagos q
    WHERE q.expediente_id = p.expediente_id
      AND q.concepto = 'estudio'
      AND q.id <> p.id
      AND q.estado IN ('pendiente', 'procesando', 'completado')
      AND (q.estado = 'completado' OR q.created_at > p.created_at
           OR (q.created_at = p.created_at AND q.id > p.id))
  );

-- 1b. Índice único parcial (excluye cancelado/fallido/reembolsado para permitir
--     reintentos legítimos tras cancelar).
CREATE UNIQUE INDEX IF NOT EXISTS uq_pagos_estudio_activo
  ON pagos (expediente_id)
  WHERE concepto = 'estudio' AND estado IN ('pendiente', 'procesando', 'completado');

-- 2. Un lote de créditos por compra (idempotencia de acreditarCompraDesdeWebhook).
--    Parcial: los lotes de ajuste_admin tienen compra_id NULL y no se ven afectados.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lotes_creditos_compra
  ON lotes_creditos_estudios (compra_id)
  WHERE compra_id IS NOT NULL;

-- 3. Pagos recibidos en la pasarela que no se pudieron conciliar con un pago en
--    BD — quedan aquí para revisión/reembolso manual en lugar de perderse.
CREATE TABLE IF NOT EXISTS pagos_no_conciliados (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proveedor          TEXT NOT NULL DEFAULT 'mercadopago',
  provider_payment_id TEXT NOT NULL,
  external_reference TEXT,
  monto              NUMERIC,
  estado_proveedor   TEXT,
  motivo             TEXT NOT NULL,
  raw_response       JSONB,
  resuelto           BOOLEAN NOT NULL DEFAULT false,
  notas              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE pagos_no_conciliados IS 'Pagos capturados por la pasarela sin pago casable en BD (link cancelado pagado, monto distinto, referencia desconocida). Revisar y reembolsar/conciliar manualmente.';

-- Retries del webhook no duplican el registro del mismo pago del proveedor.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pagos_no_conciliados_payment
  ON pagos_no_conciliados (proveedor, provider_payment_id);
