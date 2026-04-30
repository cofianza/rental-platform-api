-- =====================================================
-- Acuse del solicitante a una reprogramacion de cita
--
-- Cuando el propietario reprograma una cita ya solicitada/confirmada, el
-- solicitante necesita poder aceptar o rechazar la nueva fecha. Mientras
-- no haga ninguna de las dos, la cita esta en 'confirmada' pero pendiente
-- de su acuse — el frontend muestra un banner.
-- =====================================================

ALTER TABLE citas
  ADD COLUMN acuse_solicitante_at TIMESTAMPTZ;

-- Comentario descriptivo para que sea claro al leer el schema:
COMMENT ON COLUMN citas.acuse_solicitante_at IS
  'Timestamp en que el solicitante acuso recibo de la fecha confirmada. NULL = pendiente de revision (solo relevante cuando fecha_confirmada != fecha_propuesta, es decir, cuando hubo reprogramacion).';
