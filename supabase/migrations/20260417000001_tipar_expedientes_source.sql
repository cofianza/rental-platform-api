-- ============================================================
-- Migración: Tipar expedientes.source como enum
-- Fecha: 2026-04-17
-- Descripción:
--   Convierte expedientes.source de VARCHAR(50) a un enum
--   source_expediente con tres valores: manual, vitrina_publica,
--   invitacion. Evita typos silenciosos en código nuevo que
--   asigne valores a esta columna.
--
-- Valores actuales en DB remota: manual (2), vitrina_publica (1).
-- No hay 'invitacion' todavía (módulo expediente-externo aún
-- sin tráfico).
-- ============================================================

-- 1. Crear enum source_expediente (idempotente)
DO $$ BEGIN
  CREATE TYPE source_expediente AS ENUM (
    'manual',
    'vitrina_publica',
    'invitacion'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Normalizar valores defensivamente antes de la conversión.
--    En prod afectará 0 filas, pero protege staging/dev de datos sucios.
UPDATE expedientes
SET source = 'manual'
WHERE source IS NULL
   OR source NOT IN ('manual', 'vitrina_publica', 'invitacion');

-- 3. Convertir la columna: drop default → cambiar tipo con USING → restaurar default.
ALTER TABLE expedientes
  ALTER COLUMN source DROP DEFAULT;

ALTER TABLE expedientes
  ALTER COLUMN source TYPE source_expediente
  USING source::source_expediente;

ALTER TABLE expedientes
  ALTER COLUMN source SET DEFAULT 'manual'::source_expediente;

ALTER TABLE expedientes
  ALTER COLUMN source SET NOT NULL;

COMMENT ON COLUMN expedientes.source IS
  'Origen del expediente: manual (admin/operador), vitrina_publica (flujo Me Interesa), invitacion (cliente externo vía token).';
