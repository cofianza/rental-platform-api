-- =====================================================
-- Decision del propietario tras la visita: rechazar estudio
--
-- Cuando el propietario hace la visita y decide no proceder con el candidato
-- (no le convencio, cambio de opinion, etc.), necesita poder marcar el
-- expediente para cerrar el flujo sin habilitar el estudio crediticio.
-- El solicitante recibe email + notificacion in-app y el expediente queda
-- visible en una columna 'Sin estudio' del kanban /citas.
-- =====================================================

ALTER TABLE expedientes
  ADD COLUMN estudio_rechazado          BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN motivo_estudio_rechazado   TEXT,
  ADD COLUMN estudio_rechazado_at       TIMESTAMPTZ,
  ADD COLUMN estudio_rechazado_por      UUID REFERENCES perfiles(id);

COMMENT ON COLUMN expedientes.estudio_rechazado IS
  'TRUE cuando el propietario decidio no habilitar el estudio crediticio tras la visita. Mutuamente excluyente con estudio_habilitado=TRUE.';

COMMENT ON COLUMN expedientes.motivo_estudio_rechazado IS
  'Motivo opcional que el propietario captura al rechazar el estudio. Visible para el solicitante en el aviso.';
