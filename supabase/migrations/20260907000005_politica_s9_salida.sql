-- ============================================================
-- Politica V4.1 §9 — campos de salida de la evaluacion que faltaban
-- ------------------------------------------------------------
-- El §9 define lo que cada evaluacion debe registrar. Ya existian decision,
-- puntajes, regla dura, motivos, fecha, version, fuente del score y scores
-- individuales. Faltaban estos cinco, y tres secciones los usan:
--
--   fuente_ingreso_inferido  §9  "Enum: IBC_PILA / CENTRALES / EXTRACTOS /
--                                 MANUAL / NO_DISPONIBLE"
--   apis_fallidas            §14 "apis_fallidas incluye 'listas_restrictivas'",
--                                 "... 'registraduria'", "['transunion']"
--   tiempo_procesamiento_ms  §9  "audita el SLA de 40 segundos" (§8)
--   session_id               §9  "para deteccion de fraude y velocidad de
--                                 solicitudes" (§16.7: misma cedula, 3+
--                                 canones en 72 h -> flag)
--   analista_responsable     §9  "User ID o 'AUTOMATICO'"
--
-- Van en estudios_scorecard_sombra porque esa tabla ES el registro de la
-- evaluacion (una fila por corrida y version del modelo).
-- ============================================================

ALTER TABLE public.estudios_scorecard_sombra
  ADD COLUMN IF NOT EXISTS fuente_ingreso_inferido VARCHAR(20)
    CHECK (fuente_ingreso_inferido IS NULL OR fuente_ingreso_inferido IN ('IBC_PILA','CENTRALES','EXTRACTOS','MANUAL','NO_DISPONIBLE')),
  ADD COLUMN IF NOT EXISTS apis_fallidas TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS tiempo_procesamiento_ms INTEGER
    CHECK (tiempo_procesamiento_ms IS NULL OR tiempo_procesamiento_ms >= 0),
  ADD COLUMN IF NOT EXISTS session_id UUID,
  ADD COLUMN IF NOT EXISTS analista_responsable VARCHAR(40);

COMMENT ON COLUMN public.estudios_scorecard_sombra.apis_fallidas IS
  'Politica §14: APIs que no respondieron en esta evaluacion (datacredito, transunion, listas_restrictivas, registraduria). Vacio = todas respondieron.';
COMMENT ON COLUMN public.estudios_scorecard_sombra.tiempo_procesamiento_ms IS
  'Politica §9: desde que se tomo el lock de ejecucion hasta que se registro la decision. Audita el SLA de 40 s (§8).';
COMMENT ON COLUMN public.estudios_scorecard_sombra.session_id IS
  'Politica §9/§16.7: identificador unico de esta ejecucion, para la regla de velocidad (misma cedula, 3+ canones en 72 h).';

-- Indice para la regla de velocidad del §16.7 (por estudio -> cedula via estudios).
CREATE INDEX IF NOT EXISTS idx_scorecard_sombra_session
  ON public.estudios_scorecard_sombra (session_id) WHERE session_id IS NOT NULL;

-- La vista de cruce real vs sombra expone los campos nuevos (solo se pueden
-- AGREGAR columnas al final con CREATE OR REPLACE VIEW).
CREATE OR REPLACE VIEW public.v_estudios_sombra_vs_real AS
SELECT
  e.id                          AS estudio_id,
  e.expediente_id,
  e.proveedor,
  e.tipo                        AS tipo_estudio,
  e.resultado                   AS decision_real,
  e.score                       AS score_proveedor,
  e.fecha_completado,
  e.canon_evaluado              AS canon_congelado_estudio,
  s.canon_evaluado_cop          AS canon_de_la_corrida,
  s.modelo_version,
  s.decision_sombra,
  s.puntaje_bruto,
  s.puntaje_normalizado,
  s.puntaje_maximo_alcanzable,
  s.umbral_aprobado,
  s.umbral_revision,
  s.dti_pct,
  s.canon_ingreso_pct,
  s.ingreso_inferido_cop,
  s.cuota_mensual_cop,
  s.saldo_total_cop,
  s.saldo_mora_cop,
  s.obligaciones_vigentes,
  s.obligaciones_negativas,
  s.meses_con_mora_24m,
  s.ventana_comportamiento_meses,
  s.antiguedad_historial_meses,
  s.sectores,
  s.reglas_duras_activadas,
  s.variables_no_calculables,
  s.fecha_calculo,
  -- Adenda 1 + §9
  s.ingreso_inferido_ajustado_cop,
  s.factor_ajuste_ingreso,
  s.dti_ajustado_pct,
  s.canon_ingreso_ajustado_pct,
  s.fuente_score_externo,
  s.scores_individuales,
  s.fuente_ingreso_inferido,
  s.apis_fallidas,
  s.tiempo_procesamiento_ms,
  s.session_id,
  s.analista_responsable,
  e.proveedor_secundario,
  e.cascada
FROM public.estudios e
JOIN public.estudios_scorecard_sombra s ON s.estudio_id = e.id
WHERE e.resultado <> 'pendiente';

-- ------------------------------------------------------------
-- ROLLBACK (manual)
--   DROP INDEX IF EXISTS public.idx_scorecard_sombra_session;
--   (la vista hay que recrearla sin las columnas nuevas)
--   ALTER TABLE public.estudios_scorecard_sombra
--     DROP COLUMN IF EXISTS fuente_ingreso_inferido, DROP COLUMN IF EXISTS apis_fallidas,
--     DROP COLUMN IF EXISTS tiempo_procesamiento_ms, DROP COLUMN IF EXISTS session_id,
--     DROP COLUMN IF EXISTS analista_responsable;
