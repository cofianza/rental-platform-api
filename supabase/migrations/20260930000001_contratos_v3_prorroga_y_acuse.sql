-- ============================================================
-- Contratos V3 — Adenda 1 del módulo de contratos, respuestas 10 y 11.
-- Idempotente. Solo agrega columnas a contrato_v3_sobres (una fila por
-- proceso de firma en Auco).
-- ------------------------------------------------------------
-- (a) Respuesta 10: una sola prórroga del plazo para firmar por proceso.
--     expira_en pasa a ser el plazo vigente; aquí queda quién y cuándo lo
--     prorrogó (la marca es además el candado de "una sola vez").
-- (b) Respuesta 11: acuse del aviso de FIRMA INCOMPLETA (V3 §11.7.4). El texto
--     exacto que se entregó ya está en aviso_detalle; aquí, quién lo aceptó,
--     cuándo, y su nombre, correo, rol en la inmobiliaria e IP en ese momento
--     (valor probatorio).
--
-- La API la tolera ausente: lee estas columnas en un SELECT aparte; sin ellas
-- la prórroga y el acuse responden 503 y el resto de la firma sigue igual.
-- Correr ANTES de encender CONTRATOS_V3_ENABLED.
-- Requiere 20260925000002 (la tabla contrato_v3_sobres).
-- ROLLBACK:
--   ALTER TABLE public.contrato_v3_sobres
--     DROP COLUMN IF EXISTS plazo_prorrogado_en, DROP COLUMN IF EXISTS plazo_prorrogado_por,
--     DROP COLUMN IF EXISTS aviso_aceptado_en, DROP COLUMN IF EXISTS aviso_aceptado_por,
--     DROP COLUMN IF EXISTS aviso_aceptado_detalle;
-- ============================================================

DO $$ BEGIN
  IF to_regclass('public.contrato_v3_sobres') IS NULL THEN
    RAISE EXCEPTION 'Corre primero 20260925000002_contratos_v3_firma.sql (la tabla contrato_v3_sobres)';
  END IF;
END $$;

ALTER TABLE public.contrato_v3_sobres
  ADD COLUMN IF NOT EXISTS plazo_prorrogado_en TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS plazo_prorrogado_por UUID REFERENCES public.perfiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS aviso_aceptado_en TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS aviso_aceptado_por UUID REFERENCES public.perfiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS aviso_aceptado_detalle JSONB;

COMMENT ON COLUMN public.contrato_v3_sobres.plazo_prorrogado_en IS
  'Adenda 1 (respuesta 10): cuando se uso la unica prorroga del plazo de firma de este proceso. NULL = sin prorroga.';
COMMENT ON COLUMN public.contrato_v3_sobres.aviso_aceptado_en IS
  'Adenda 1 (respuesta 11): acuse del aviso de firma incompleta. Detalle: {nombre, email, rolMiembro, ip, textoVersion}.';

-- Verificacion (solo lectura; 5 filas):
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'contrato_v3_sobres'
--     AND column_name IN ('plazo_prorrogado_en', 'plazo_prorrogado_por',
--                         'aviso_aceptado_en', 'aviso_aceptado_por', 'aviso_aceptado_detalle')
--   ORDER BY column_name;
