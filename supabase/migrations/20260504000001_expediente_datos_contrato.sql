-- ============================================================
-- Datos del contrato capturados antes de habilitar el estudio.
--
-- Cuando el propietario decide "Habilitar estudio" tras la cita realizada,
-- ahora le pedimos primero la duracion del contrato (meses) y la fecha de
-- inicio. Estos datos viven en el expediente y luego alimentan la
-- generacion del contrato cuando el estudio se aprueba — el operador no
-- los tiene que volver a pedir.
--
-- Reglas:
-- - Editables hasta que se habilite el estudio (estudio_habilitado=false).
-- - Una vez habilitado el estudio, los datos quedan congelados.
-- - duracion_contrato_meses: SMALLINT >= 1, sin techo logico (consultar
--   con cliente si quiere validar maximo).
-- - fecha_inicio_contrato: DATE (sin tiempo). Puede ser fecha pasada o
--   futura — el frontend valida razonabilidad si lo necesita.
-- ============================================================

ALTER TABLE expedientes
  ADD COLUMN IF NOT EXISTS duracion_contrato_meses SMALLINT,
  ADD COLUMN IF NOT EXISTS fecha_inicio_contrato   DATE;

COMMENT ON COLUMN expedientes.duracion_contrato_meses IS
  'Duracion del contrato en meses, capturada al habilitar el estudio. Alimenta el contrato cuando se genere.';

COMMENT ON COLUMN expedientes.fecha_inicio_contrato IS
  'Fecha tentativa de inicio del contrato. Capturada al habilitar el estudio para que el contrato salga con esos datos sin re-pedirlos.';

-- Constraint: si duracion esta seteada, debe ser >= 1.
ALTER TABLE expedientes
  DROP CONSTRAINT IF EXISTS expedientes_duracion_contrato_chk;

ALTER TABLE expedientes
  ADD CONSTRAINT expedientes_duracion_contrato_chk CHECK (
    duracion_contrato_meses IS NULL OR duracion_contrato_meses >= 1
  );
