-- ============================================================
-- Moras: una sola mora activa por canon (contrato + fecha de vencimiento).
--
-- reportarMora ya responde 409 MORA_DUPLICADA si encuentra una activa; este
-- índice cubre el doble clic o dos reportes simultáneos (el insert choca con
-- 23505 y la API lo convierte en el mismo 409). Las moras pagadas o canceladas
-- no cuentan: el mismo canon se puede volver a reportar si se cerró por error.
--
-- Al 2026-09-23 no había ninguna mora en producción, así que no hay
-- duplicados que limpiar. Si el índice fallara por duplicados, esta consulta
-- los muestra:
--   SELECT contrato_id, fecha_vencimiento_canon, array_agg(ticket_numero)
--   FROM moras_tickets WHERE estado IN ('fase_1','fase_2','fase_3')
--   GROUP BY 1, 2 HAVING count(*) > 1;
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS moras_tickets_activa_por_canon_uniq
  ON moras_tickets (contrato_id, fecha_vencimiento_canon)
  WHERE estado IN ('fase_1', 'fase_2', 'fase_3');
