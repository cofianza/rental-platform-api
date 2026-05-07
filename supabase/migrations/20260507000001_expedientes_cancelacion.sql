-- ============================================================
-- Distinguir "cerrar expediente" (cierre natural tras flujo completado) de
-- "cancelar expediente" (abandono mid-flow).
--
-- Hasta hoy ambas acciones llevaban al expediente a estado='cerrado' sin
-- diferenciacion en BD. La UI mostraba "Expediente finalizado" + todos los
-- pasos en verde aunque el caso real fuera una cancelacion (eg. propietario
-- decide no proceder con el contrato post-aprobacion). Esto confunde al
-- solicitante porque le dice que su flujo se completo cuando en realidad fue
-- cancelado por el propietario.
--
-- Agregamos 3 columnas no-mutuamente-exclusivas con cancelado_at como flag
-- principal. NULL = no fue cancelado (cierre natural / aun no terminal).
--
-- Mantenemos estado='cerrado' como unico terminal para no inflacionar el
-- state machine; la "cancelacion" es un sub-tipo del cierre.
-- ============================================================

ALTER TABLE expedientes
  ADD COLUMN cancelado_at TIMESTAMPTZ,
  ADD COLUMN motivo_cancelacion TEXT,
  ADD COLUMN estado_pre_cancelacion estado_expediente;

COMMENT ON COLUMN expedientes.cancelado_at IS
  'Timestamp cuando el expediente se cancelo (vs cierre natural). NULL = no fue cancelado.';

COMMENT ON COLUMN expedientes.motivo_cancelacion IS
  'Comentario obligatorio capturado en el modal "Cancelar expediente". Visible al solicitante en su panel.';

COMMENT ON COLUMN expedientes.estado_pre_cancelacion IS
  'Estado del expediente justo antes de la cancelacion. Usado por la UI para marcar hasta donde avanzo el proceso (steps completados vs pendientes).';
