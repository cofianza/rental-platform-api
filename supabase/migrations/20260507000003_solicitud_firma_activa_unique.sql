-- ============================================================
-- Garantizar que un contrato solo tenga UNA solicitud de firma activa
-- a la vez.
--
-- Bug detectado en EXP-2026-0009 (7-may-2026): dos requests concurrentes
-- pasaron el guard in-memory (autoGenInflight) y subieron 2 documentos a
-- Auco con 322ms de diferencia. Resultado: Auco con 2 docs activos
-- asociados al mismo telefono → al hacer click "Comenzar" mostraba "No
-- tienes documentos pendientes por firmar". El guard in-memory no protege
-- ante races porque el SELECT inicial de `solicitudes_firma` toma ~50ms y
-- ambos threads ven la tabla vacia antes de insertar.
--
-- Esta unique partial index lo arregla a nivel BD: el segundo INSERT con
-- el mismo contrato_id en estado activo falla con violacion de unique
-- constraint. dispatchAutoFirma puede capturar el error y tratarlo como
-- "otra request ya hizo el trabajo".
--
-- Estados activos = ['enviado', 'abierto']. Cancelado/firmado/expirado son
-- terminales y no deberian bloquear nuevos intentos.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS solicitudes_firma_contrato_activa_unique
ON solicitudes_firma (contrato_id)
WHERE estado IN ('enviado', 'abierto');

COMMENT ON INDEX solicitudes_firma_contrato_activa_unique IS
  'Solo una solicitud de firma activa por contrato. Previene race conditions cuando dos requests simultaneos disparan dispatchAutoFirma para el mismo contrato.';
