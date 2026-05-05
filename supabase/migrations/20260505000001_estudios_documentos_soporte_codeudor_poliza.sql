-- ============================================================
-- Ampliar propósitos de documentos soporte para flujo condicionado.
--
-- Mario (5-may-2026): cuando el buró deja un estudio condicionado,
-- el propietario puede pedir al solicitante que suba documentación
-- adicional para tomar la decisión manual. Los propósitos típicos en
-- el flujo colombiano son codeudor (datos del avalista) y póliza
-- (seguro de arrendamiento). Antes solo existían los propósitos
-- pensados para re-evaluación (certificacion_laboral, extractos,
-- declaracion_renta, carta_referencia, otros_soportes).
--
-- Reusamos la misma tabla `estudios_documentos_soporte` — el flujo
-- condicionado y el de re-evaluación comparten el storage de docs.
-- ============================================================

ALTER TABLE estudios_documentos_soporte
  DROP CONSTRAINT IF EXISTS estudios_documentos_soporte_proposito_check;

ALTER TABLE estudios_documentos_soporte
  ADD CONSTRAINT estudios_documentos_soporte_proposito_check
  CHECK (proposito IN (
    'certificacion_laboral',
    'extractos_bancarios',
    'declaracion_renta',
    'carta_referencia',
    'codeudor',
    'poliza',
    'otros_soportes'
  ));
