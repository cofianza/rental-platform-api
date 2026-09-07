-- ============================================================
-- estudios.antecedentes — background check de Auco (Politica V4.1)
-- ------------------------------------------------------------
-- Guarda el resumen de GET /validate/background de Auco tal como lo
-- interpreto src/modules/estudios/antecedentes.ts: estado (verificado /
-- no_verificado / desactivado), code del proceso, listas vinculantes
-- (OFAC/ONU), flags de revision manual, FOSYGA (V4 del scorecard) y el bloque
-- `validation` como evidencia (sin `reputacional`).
--
-- Se escribe ANTES de fn_registrar_resultado_estudio, en un UPDATE aparte
-- (mismo patron que respuesta_proveedor): asi los tres caminos que llegan al
-- RPC —inline, polling y registro manual— leen el mismo dato al decidir.
--
-- Ademas amplia el CHECK de estudios.regla_dura_activada con
-- 'listas_restrictivas' (§6: "Reporte en listas restrictivas (OFAC, ONU,
-- listas Clinton) -> RECHAZO AUTOMATICO"). Sin esto, el UPDATE de
-- trazabilidad fallaria (y el rechazo quedaria igual, con su motivo en
-- motivo_rechazo — ver registrarReglaDuraActivada).
--
-- Nada aqui decide: la regla solo se activa con AUCO_BACKGROUND_CHECK_ENABLED.
-- ============================================================

ALTER TABLE public.estudios
  ADD COLUMN IF NOT EXISTS antecedentes JSONB;

COMMENT ON COLUMN public.estudios.antecedentes IS
  'Resumen del background check de Auco (listas restrictivas OFAC/ONU, flags de revision manual, FOSYGA, registraduria) + bloque validation como evidencia. NULL si no se consulto. Ver src/modules/estudios/antecedentes.ts.';

ALTER TABLE public.estudios
  DROP CONSTRAINT IF EXISTS chk_estudios_regla_dura_activada;

ALTER TABLE public.estudios ADD CONSTRAINT chk_estudios_regla_dura_activada
  CHECK (
    regla_dura_activada IS NULL
    OR (
      cardinality(regla_dura_activada) > 0
      AND regla_dura_activada <@ ARRAY[
        'score_menor_450',
        'dti_mayor_65',
        'canon_ingreso_mayor_40',
        'mora_vigente',
        'mora_mayor_30d_6m',
        'listas_restrictivas'
      ]::TEXT[]
    )
  );

-- ------------------------------------------------------------
-- ROLLBACK (manual, no se ejecuta aqui)
--
--   ALTER TABLE public.estudios DROP COLUMN IF EXISTS antecedentes;
--   (y restaurar el CHECK anterior sin 'listas_restrictivas' solo si ninguna
--   fila lo usa: SELECT count(*) FROM estudios
--     WHERE regla_dura_activada @> ARRAY['listas_restrictivas']::TEXT[];)
