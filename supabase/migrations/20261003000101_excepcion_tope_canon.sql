-- ============================================================
-- Adenda de precios v1.0 §7.3-7.4: excepción de tope de canon.
--
-- Por encima del tope (CANON_MAX_TRANSITORIO / TOPE_CANON_COMERCIAL) el
-- estudio pasa al analista, pero solo la Gerencia General lo aprueba. La
-- aprobación de la excepción queda registrada con usuario, fecha, hora y el
-- canon autorizado, que es un TECHO: el contrato no puede superarlo.
--
--   expedientes.excepcion_tope_canon_cop  canon máximo autorizado (pesos)
--   expedientes.excepcion_tope_por        quién la autorizó (perfiles.id)
--   expedientes.excepcion_tope_en         cuándo
--   expedientes.excepcion_tope_motivo     por qué (caso por caso, §10)
--
-- Solo SUMA columnas. Idempotente. RLS: la tabla ya lo tiene. Correrla ANTES
-- de desplegar el API: el detalle del estudio las selecciona.
--
-- Verificación:
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'expedientes'
--     AND column_name LIKE 'excepcion_tope_%';   -- 4 filas
-- ============================================================
ALTER TABLE public.expedientes
  ADD COLUMN IF NOT EXISTS excepcion_tope_canon_cop numeric(14,2),
  ADD COLUMN IF NOT EXISTS excepcion_tope_por uuid REFERENCES public.perfiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS excepcion_tope_en timestamptz,
  ADD COLUMN IF NOT EXISTS excepcion_tope_motivo text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expedientes_excepcion_tope_canon_positivo') THEN
    ALTER TABLE public.expedientes
      ADD CONSTRAINT expedientes_excepcion_tope_canon_positivo
      CHECK (excepcion_tope_canon_cop IS NULL OR excepcion_tope_canon_cop > 0);
  END IF;
END $$;

COMMENT ON COLUMN public.expedientes.excepcion_tope_canon_cop IS
  'Adenda de precios §7.4: canon máximo que la Gerencia General autorizó por encima del tope (techo del contrato).';
COMMENT ON COLUMN public.expedientes.excepcion_tope_por IS
  'Adenda de precios §7.4: administrador de la Gerencia General que autorizó la excepción de tope.';
COMMENT ON COLUMN public.expedientes.excepcion_tope_en IS
  'Adenda de precios §7.4: fecha y hora de la autorización de la excepción de tope.';
COMMENT ON COLUMN public.expedientes.excepcion_tope_motivo IS
  'Adenda de precios §7.4 y §10: motivo escrito de la excepción (caso por caso).';
