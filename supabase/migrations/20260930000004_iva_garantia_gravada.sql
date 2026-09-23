-- ============================================================
-- Adenda 1 del módulo de contratos §1.6 y respuesta 8: la prima y la tarifa
-- de la fianza se facturan GRAVADAS con IVA. La prima se cobra con el concepto
-- 'garantia' (en pantalla, «Prima de vinculación de la fianza»), que
-- 20260427000003 dejó en 0 (exento). Al 2026-09-23 no hay pagos de garantía
-- ni facturas emitidas: no hay nada que corregir hacia atrás.
--
-- La factura ya no lee esta fila para la garantía: toma TARIFA_IVA (calibración),
-- la misma tasa con la que se cobró la prima, y el monto como total con IVA
-- incluido (base = monto / 1,19, impuesto 01 al 19 %). La pantalla de Tarifas
-- de IVA la muestra derivada de TARIFA_IVA y no la deja cambiar. Esta
-- migración solo deja la fila coherente con eso (antes decía 0 = exento).
--
-- Quedan como están:
--   - estudio: la Adenda no lo toca.
--   - primer_canon: el canon no es ingreso de Cofianza; si el cobro trae
--     además la tarifa del primer mes, hay que separarla (concepto propio),
--     no gravar el canon entero.
--   - deposito / otro.
-- La tarifa mensual no tiene concepto: la plataforma no la cobra (la recauda
-- el arrendador con el canon: contrato V4 cláusula 3.ª, Anexo V3 cláusula 11.ª).
--
-- Idempotente. Verificación:
--   SELECT clave, valor FROM configuracion_sistema WHERE clave LIKE 'iva_concepto_%' ORDER BY clave;
--   -- iva_concepto_garantia = 19; las otras cuatro siguen en 0.
-- ============================================================

INSERT INTO configuracion_sistema (clave, valor, descripcion)
VALUES (
  'iva_concepto_garantia',
  '19',
  'Tasa de IVA (%) de la prima de vinculación (concepto garantia): gravada, la fija TARIFA_IVA (Adenda 1 de contratos §1.6).'
)
ON CONFLICT (clave) DO UPDATE
  SET valor = EXCLUDED.valor,
      descripcion = EXCLUDED.descripcion,
      updated_at = now();
