-- ============================================================
-- Adenda 1 del módulo de contratos §1.6 y respuesta 8: la prima y la tarifa
-- de la fianza se facturan GRAVADAS con IVA. La prima se cobra con el concepto
-- 'garantia' («Garantía de arrendamiento»), que 20260427000003 dejó en 0
-- (exento). Al 2026-09-23 no hay pagos de garantía ni facturas emitidas: no
-- hay nada que corregir hacia atrás.
--
-- Con tasa > 0, facturacion.service toma el monto del pago como total con IVA
-- incluido: base = monto / 1,19 e impuesto 01 (IVA) al 19 %. Mientras esté en
-- 0, la API no factura la garantía (IVA_CONCEPTO_GRAVADO_EN_CERO).
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
-- Reversa: UPDATE configuracion_sistema SET valor = '0' WHERE clave = 'iva_concepto_garantia';
-- ============================================================

INSERT INTO configuracion_sistema (clave, valor, descripcion)
VALUES (
  'iva_concepto_garantia',
  '19',
  'Tasa de IVA (%) para garantía de arrendamiento (prima de vinculación). Gravada: Adenda 1 del módulo de contratos §1.6.'
)
ON CONFLICT (clave) DO UPDATE
  SET valor = EXCLUDED.valor,
      descripcion = EXCLUDED.descripcion,
      updated_at = now();
