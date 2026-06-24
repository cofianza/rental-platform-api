-- ============================================================
-- Ajuste fino del bloque de firmas: la firma quedaba "muy arriba".
--
-- La firma se estampa (Auco) pegada al borde SUPERIOR de la caja .firma-line y
-- baja; la línea es el borde INFERIOR de esa caja. Con height:48px la caja era
-- más alta que la firma, dejando un hueco grande entre la firma y la línea.
--
-- Bajamos la altura a 30px para que la línea suba y quede JUSTO debajo de la
-- firma. Disposición: firma · línea · nombre/rol.
--
-- Solo afecta contratos GENERADOS a partir de ahora (el HTML se renderiza desde
-- la plantilla al generar; los PDFs ya emitidos no cambian).
-- ============================================================

UPDATE plantillas_contrato
SET contenido_html = REPLACE(
  contenido_html,
  '.firma-line { border-bottom: 1px solid #000; width: 290px; height: 48px; margin-top: 26px; margin-bottom: 3px; }',
  '.firma-line { border-bottom: 1px solid #000; width: 290px; height: 30px; margin-top: 26px; margin-bottom: 3px; }'
)
WHERE contenido_html LIKE '%.firma-line { border-bottom: 1px solid #000; width: 290px; height: 48px; margin-top: 26px; margin-bottom: 3px; }%';
