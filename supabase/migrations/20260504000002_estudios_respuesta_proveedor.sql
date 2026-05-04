-- ============================================================
-- estudios.respuesta_proveedor — JSONB con la respuesta cruda del buró
--
-- Hasta hoy la respuesta de TransUnion (Combo 1901) se guardaba solo en
-- un cache en memoria del provider. Tras un redeploy de Railway el cache
-- se vacía y el modal "Detalle del Estudio" mostraba la sección "Reporte
-- TransUnion" vacía: el frontend leía `datos_formulario` (que es el INPUT
-- del form, no la respuesta), y como no encontraba `Tercero`, `Consolidado`
-- ni `HuellaConsulta` no renderizaba nada.
--
-- Esta columna persiste el JSON completo del proveedor, de modo que el
-- detalle del estudio sea reconstruible aunque el cache se haya perdido,
-- y queda como evidencia auditable de qué fue lo que el buró devolvió.
--
-- Aplica a TransUnion hoy y queda lista para Datacrédito/SIFIN cuando se
-- integren — todos guardan el JSON crudo del proveedor en este campo.
-- ============================================================

ALTER TABLE estudios
  ADD COLUMN IF NOT EXISTS respuesta_proveedor JSONB;

COMMENT ON COLUMN estudios.respuesta_proveedor IS
  'Respuesta cruda (JSON) del buró de crédito. Para TransUnion: Combo 1901 con Tercero, Consolidado, HuellaConsulta. Se popula tras fn_registrar_resultado_estudio en registrarResultadoInline.';
