-- ============================================================
-- Tarifas de IVA por concepto (configurables por admin).
--
-- Default: 0 (exento) para todos los servicios de Cofianza, ya que el
-- estudio crediticio y la garantía son servicios financieros excluidos
-- de IVA. El admin puede ajustar estos valores desde la UI.
-- ============================================================

INSERT INTO configuracion_sistema (clave, valor, descripcion)
VALUES
  ('iva_concepto_estudio',      '0', 'Tasa de IVA (%) para estudio crediticio. 0 = exento.'),
  ('iva_concepto_garantia',     '0', 'Tasa de IVA (%) para garantía de arrendamiento. 0 = exento.'),
  ('iva_concepto_primer_canon', '0', 'Tasa de IVA (%) para primer canon. 0 = exento.'),
  ('iva_concepto_deposito',     '0', 'Tasa de IVA (%) para depósito. 0 = exento.'),
  ('iva_concepto_otro',         '0', 'Tasa de IVA (%) para otros conceptos. 0 = exento.')
ON CONFLICT (clave) DO NOTHING;
