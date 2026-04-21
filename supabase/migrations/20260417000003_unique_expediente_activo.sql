-- ============================================================
-- Migración: Índice único parcial para expedientes activos
-- Fecha: 2026-04-17
-- Descripción:
--   Previene que un mismo solicitante tenga dos expedientes
--   activos sobre el mismo inmueble. Estados considerados
--   "activos": borrador, en_revision, informacion_incompleta,
--   aprobado, condicionado. Los terminales (rechazado, cerrado)
--   quedan fuera del índice, permitiendo re-aplicar tras un
--   rechazo o cierre previo.
--
--   Este índice ya fue aplicado manualmente en cofianza-dev el
--   2026-04-17 tras cleanup one-off del expediente duplicado
--   EXP-2026-0006 (marcado como 'cerrado' para liberar el
--   par (inmueble_id, solicitante_id) que violaba la unicidad).
--   Esta migración versiona el índice para futuros reset/redeploy.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_expediente_activo_solicitante_inmueble
  ON expedientes (inmueble_id, solicitante_id)
  WHERE estado IN (
    'borrador',
    'en_revision',
    'informacion_incompleta',
    'aprobado',
    'condicionado'
  );

COMMENT ON INDEX idx_expediente_activo_solicitante_inmueble IS
  'Previene duplicados: un solicitante no puede tener dos expedientes activos sobre el mismo inmueble. Excluye estados terminales (rechazado, cerrado).';
