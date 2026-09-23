-- ============================================================
-- Adenda 1 del módulo de contratos §1.2 y §1.5: la base de cálculo de la
-- fianza es el canon SIN IVA en ambas destinaciones; prima, tarifa y cobertura
-- se calculan sobre el canon. Se elimina la base «canon + IVA» del Complemento
-- comercial (§4.1 / BASE_CALCULO_FIANZA_COMERCIAL) que tenía
-- base_calculo_fianza_cop. Idempotente. El API no lee ni escribe la columna:
-- funciona igual antes y después de correrla.
--
-- 20260921000001 pedía no cambiar la expresión porque recalcula los contratos
-- existentes. Aquí ningún valor cambia: el comercial nunca se habilitó, todo
-- contrato V3 tiene iva_canon_pct = 0 (canon + IVA ya era el canon) y los
-- legacy (destinacion NULL) siguen en NULL. Si apareciera un contrato fuera de
-- borrador con IVA del canon, la migración aborta en vez de reescribir la base
-- de algo firmado.
--
-- Revisión de solo lectura en producción (2026-09-23): la columna no tiene
-- vistas, funciones ni índices que dependan de ella (solo su propia
-- expresión); 7 contratos, 0 V3, 0 con iva_canon_pct distinto de NULL/0.
-- ALTER COLUMN ... SET EXPRESSION exige PostgreSQL 17 (producción: 17.6).
-- Todo va en una transacción: si la guarda aborta, el ALTER no corre, también
-- con psql -f sin ON_ERROR_STOP.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.contratos
    WHERE coalesce(iva_canon_pct, 0) <> 0 AND estado <> 'borrador'
  ) THEN
    RAISE EXCEPTION 'Hay contratos fuera de borrador con IVA del canon: revisar antes de cambiar su base de cálculo';
  END IF;
END $$;

ALTER TABLE public.contratos
  ALTER COLUMN base_calculo_fianza_cop
  SET EXPRESSION AS (CASE WHEN destinacion IS NOT NULL THEN valor_arriendo END);

COMMENT ON COLUMN public.contratos.base_calculo_fianza_cop IS
  'Base de prima, tarifa y cobertura: el canon SIN IVA en toda destinación (Adenda 1 del módulo de contratos §1.2 y §1.5; ya no es canon + IVA en comercial). NULL en legacy V1/V4.';
COMMENT ON COLUMN public.contratos.valor_arriendo IS
  'Canon mensual SIN IVA: base de prima, tarifa y cobertura (tope de 18 cánones) en toda destinación (Adenda 1 del módulo de contratos §1.2).';

COMMIT;

-- Verificación (solo lectura, después de correrla):
--   SELECT generation_expression FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'contratos' AND column_name = 'base_calculo_fianza_cop';
--   -- esperado: CASE WHEN (destinacion IS NOT NULL) THEN valor_arriendo ELSE NULL::numeric END
--   SELECT count(*) FILTER (WHERE destinacion IS NOT NULL AND base_calculo_fianza_cop IS DISTINCT FROM valor_arriendo) AS v3_distinta,
--          count(*) FILTER (WHERE destinacion IS NULL AND base_calculo_fianza_cop IS NOT NULL) AS legacy_con_base
--     FROM public.contratos;
--   -- esperado: 0 y 0
--
-- ROLLBACK (manual):
--   ALTER TABLE public.contratos ALTER COLUMN base_calculo_fianza_cop
--     SET EXPRESSION AS (valor_arriendo + round(valor_arriendo * iva_canon_pct / 100));
