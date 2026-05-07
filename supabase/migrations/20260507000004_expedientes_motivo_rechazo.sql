-- ============================================================
-- Persistir el motivo del rechazo del expediente.
--
-- Cuando un expediente termina en estado='rechazado' (sea por estudio del
-- titular fallido o por ponderación con co-arrendatario también marginal),
-- queremos mostrar al solicitante y al propietario el motivo concreto en el
-- banner de cierre. Hasta hoy esa razón vivía solo en `eventos_timeline`,
-- lo que obligaba a renderizar leyendo eventos.
--
-- Espejo del patrón existente de `motivo_cancelacion` (ver 20260507000001).
-- NULL = sin motivo registrado (legacy o rechazo manual sin captura).
-- ============================================================

ALTER TABLE expedientes
  ADD COLUMN IF NOT EXISTS motivo_rechazo TEXT;

COMMENT ON COLUMN expedientes.motivo_rechazo IS
  'Motivo legible del rechazo del expediente. Lo escribe el orchestrator/coarrendatarios.service al transicionar a rechazado. Visible al solicitante y al propietario en el banner del expediente cerrado.';
