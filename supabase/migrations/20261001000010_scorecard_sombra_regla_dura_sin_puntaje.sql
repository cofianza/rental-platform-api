-- ============================================================
-- Nota anexa a la matriz QA V2 (Gerencia) §2.4: la regla dura no calcula puntaje.
-- ------------------------------------------------------------
-- «Las reglas duras no calculan puntaje. En los casos marcados con regla dura,
-- el motor debe rechazar sin calcular las variables restantes. Si el motor
-- devuelve un puntaje en esos casos, la prueba falla aunque la decision sea
-- correcta.»
--
-- Desde este cambio evaluarSombra (src/modules/estudios/motor/index.ts)
-- entrega un rechazo por regla dura con puntaje_normalizado NULL. El CHECK
-- chk_scorecard_sombra_no_calculable (migracion 20260903000001) solo admitia
-- puntaje NULL con decision 'no_calculable'. Se amplia con un tercer caso:
--
--   decision_sombra = 'rechazado' AND puntaje_normalizado IS NULL
--   AND al menos una regla dura en reglas_duras_activadas
--
-- Solo relaja: toda fila existente cumple el CHECK viejo y por lo tanto el
-- nuevo. Un 'aprobado' o 'revision_manual' sin puntaje sigue prohibido.
--
-- COMPATIBLE HACIA ATRAS: la API ya desplegada funciona sin esta migracion.
-- Si el upsert de la fila sombra choca con el CHECK viejo (23514), sombra.service
-- reintenta la misma fila como 'no_calculable' (lo que hacia antes, con la regla
-- en motivo_no_calculable y reglas_duras_activadas). La decision del estudio
-- nunca depende de esta escritura. Idempotente.
-- ============================================================

ALTER TABLE public.estudios_scorecard_sombra
  DROP CONSTRAINT IF EXISTS chk_scorecard_sombra_no_calculable;

ALTER TABLE public.estudios_scorecard_sombra
  ADD CONSTRAINT chk_scorecard_sombra_no_calculable CHECK (
    (decision_sombra =  'no_calculable' AND puntaje_normalizado IS NULL)
    OR
    (decision_sombra <> 'no_calculable' AND puntaje_normalizado IS NOT NULL)
    OR
    (decision_sombra = 'rechazado' AND puntaje_normalizado IS NULL
      AND cardinality(reglas_duras_activadas) > 0)
  );

COMMENT ON CONSTRAINT chk_scorecard_sombra_no_calculable ON public.estudios_scorecard_sombra IS
  'Sin puntaje solo hay dos decisiones: no_calculable, o rechazado por regla dura (nota QA V2 §2.4: la regla dura no calcula puntaje).';

-- ROLLBACK (no ejecutar como parte de esta migracion). Antes, pasar las filas
-- nuevas al formato viejo o el ADD fallara:
--   UPDATE public.estudios_scorecard_sombra SET decision_sombra = 'no_calculable'
--    WHERE decision_sombra = 'rechazado' AND puntaje_normalizado IS NULL;
--   ALTER TABLE public.estudios_scorecard_sombra DROP CONSTRAINT chk_scorecard_sombra_no_calculable;
--   ALTER TABLE public.estudios_scorecard_sombra ADD CONSTRAINT chk_scorecard_sombra_no_calculable CHECK (
--     (decision_sombra = 'no_calculable' AND puntaje_normalizado IS NULL)
--     OR (decision_sombra <> 'no_calculable' AND puntaje_normalizado IS NOT NULL));
