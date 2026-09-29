-- ============================================================
-- H58/H103: códigos de los motivos de decisión (A1–A9, R1–R9, C1–C6; ver
-- src/modules/estudios/motivos-decision.ts), además del texto que ya se
-- guardaba. Solo SUMA columnas: nada se borra ni se reescribe.
--
--   estudios.motivos_decision          → registrar resultado (rechazar/condicionar)
--   eventos_timeline.motivos_decision  → rechazar o aprobar una revisión manual
--                                        (cambio de estado y «Aprobar estudio»)
--
-- El API las llena en un UPDATE aparte que no lanza: si la columna falta, la
-- decisión queda guardada con sus textos y se registra un logger.error.
-- (Nota 2026-09-28: aplicada en prod; este comentario no exige volver a correrla.)
-- Idempotente. RLS: las tablas ya lo tienen; una columna nueva no cambia nada.
--
-- Verificación:
--   SELECT table_name, column_name, data_type FROM information_schema.columns
--   WHERE table_schema = 'public' AND column_name = 'motivos_decision';   -- 2 filas, ARRAY
-- Rollback:
--   ALTER TABLE public.estudios DROP COLUMN IF EXISTS motivos_decision;
--   ALTER TABLE public.eventos_timeline DROP COLUMN IF EXISTS motivos_decision;
-- ============================================================
ALTER TABLE public.estudios ADD COLUMN IF NOT EXISTS motivos_decision text[];
ALTER TABLE public.eventos_timeline ADD COLUMN IF NOT EXISTS motivos_decision text[];

COMMENT ON COLUMN public.estudios.motivos_decision IS
  'Códigos de motivo elegidos por el analista al rechazar o condicionar (motivos-decision.ts).';
COMMENT ON COLUMN public.eventos_timeline.motivos_decision IS
  'Códigos de motivo de una decisión manual (rechazar o aprobar revisión manual).';
