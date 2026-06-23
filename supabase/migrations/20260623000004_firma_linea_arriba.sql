-- ============================================================
-- Firma ARRIBA de la línea en el bloque de firmas del contrato.
--
-- Antes: `.firma-line { border-top: 1px solid #000; ... }` → la línea quedaba
-- ARRIBA y, como el ancla {{signature:N}} (que Auco estampa hacia abajo) se
-- inyecta dentro del div, la firma caía DEBAJO de la línea (sobre el nombre).
--
-- Ahora: la línea pasa a ser el borde INFERIOR de una caja con altura. El ancla
-- (arriba de la caja) hace que Auco estampe la firma DENTRO de la caja, ENCIMA
-- de la línea; el nombre/rol va debajo. Disposición convencional: firma · línea ·
-- nombre. No requiere cambio de código (el ancla sigue dentro de .firma-line).
--
-- Solo afecta contratos GENERADOS a partir de ahora (el HTML se renderiza desde
-- la plantilla al generar; los PDFs ya emitidos no cambian).
-- ============================================================

UPDATE plantillas_contrato
SET contenido_html = REPLACE(
  contenido_html,
  '.firma-line { border-top: 1px solid #000; width: 290px; margin-top: 26px; margin-bottom: 3px; }',
  '.firma-line { border-bottom: 1px solid #000; width: 290px; height: 48px; margin-top: 26px; margin-bottom: 3px; }'
)
WHERE contenido_html LIKE '%.firma-line { border-top: 1px solid #000; width: 290px; margin-top: 26px; margin-bottom: 3px; }%';
