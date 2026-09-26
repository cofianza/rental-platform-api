-- ============================================================
-- Politica V4.1 §4.2: el DTI de la fila sombra con la cuota de la fianza.
-- ------------------------------------------------------------
-- El motor (src/modules/estudios/motor/index.ts) calcula el DTI como
-- (cuota del buro + cuota de la fianza con IVA) / ingreso, y guarda la cuota
-- de la fianza en features_crudas.cuota_fianza_cop. Las columnas generadas
-- dti_pct (ingreso crudo, 20260903000001) y dti_ajustado_pct (ingreso
-- ajustado, 20260907000004) solo dividian la cuota del buro: la tabla decia
-- un DTI menor que el que decidio el motor y que el motivo del gestor.
--
-- Se recrean las dos sumando la cuota de la fianza cuando features_crudas la
-- trae como numero. Filas anteriores (sin ese dato, o sin canon): suman 0 y
-- quedan exactamente igual. Sin cuota del buro sigue saliendo NULL, como en
-- el motor. El jsonb_typeof evita que un valor no numerico tumbe el INSERT
-- entero de la corrida.
--
-- Una columna generada no cambia de expresion en Postgres < 17: se borra y se
-- vuelve a agregar (quedan al final de la tabla; nadie las lee por posicion).
-- La vista v_estudios_sombra_vs_real depende de ellas: se borra y se recrea
-- con la definicion vigente (20260907000005) y se repiten los REVOKE — una
-- vista nueva en public nace con los permisos por defecto de Supabase.
-- Sin CASCADE a proposito: si algo mas depende de estas columnas, falla y la
-- transaccion no cambia nada.
--
-- COMPATIBLE HACIA ATRAS: la API nunca escribe estas columnas (fila.ts no las
-- envia) ni las lee; la vista conserva sus columnas y su orden. Idempotente.
-- Reescribe la tabla (pocas filas). No escribe datos.
-- ============================================================

BEGIN;

DROP VIEW IF EXISTS public.v_estudios_sombra_vs_real;

ALTER TABLE public.estudios_scorecard_sombra
  DROP COLUMN IF EXISTS dti_pct,
  DROP COLUMN IF EXISTS dti_ajustado_pct;

ALTER TABLE public.estudios_scorecard_sombra
  ADD COLUMN dti_pct NUMERIC(12,2) GENERATED ALWAYS AS (
    ROUND(
      (
        (cuota_mensual_cop
          + CASE WHEN jsonb_typeof(features_crudas -> 'cuota_fianza_cop') = 'number'
                 THEN (features_crudas ->> 'cuota_fianza_cop')::numeric ELSE 0 END)
        / NULLIF(ingreso_inferido_cop, 0)
      ) * 100, 2)
  ) STORED,
  ADD COLUMN dti_ajustado_pct NUMERIC(12,2) GENERATED ALWAYS AS (
    ROUND(
      (
        (cuota_mensual_cop
          + CASE WHEN jsonb_typeof(features_crudas -> 'cuota_fianza_cop') = 'number'
                 THEN (features_crudas ->> 'cuota_fianza_cop')::numeric ELSE 0 END)
        / NULLIF(ingreso_inferido_ajustado_cop, 0)
      ) * 100, 2)
  ) STORED;

COMMENT ON COLUMN public.estudios_scorecard_sombra.dti_pct IS
  'V2 (Politica §4.2) sobre el ingreso CRUDO: (cuota del buro + features_crudas.cuota_fianza_cop) / ingreso_inferido_cop * 100. Generada (STORED). Sin cuota de la fianza (filas anteriores o sin canon) = solo la del buro. NULL si falta ingreso o cuota.';
COMMENT ON COLUMN public.estudios_scorecard_sombra.dti_ajustado_pct IS
  'V2 (Politica §4.2, Adenda 1 §1.1) sobre el ingreso AJUSTADO: (cuota del buro + features_crudas.cuota_fianza_cop) / ingreso_inferido_ajustado_cop * 100. Es el DTI con el que decide el motor. Generada (STORED).';

CREATE VIEW public.v_estudios_sombra_vs_real AS
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

-- Solo service_role (la API) la lee: no hereda la RLS de las tablas base.
REVOKE ALL ON public.v_estudios_sombra_vs_real FROM PUBLIC;
REVOKE ALL ON public.v_estudios_sombra_vs_real FROM anon, authenticated;

COMMENT ON VIEW public.v_estudios_sombra_vs_real IS
  'Cruce solo-lectura decision real vs decision sombra por estudio. Responde "cuantos de los que hoy aprobamos caerian en revision manual". No la consuma ningun flujo transaccional.';

COMMIT;

-- ------------------------------------------------------------
-- VERIFICACION (solo lectura)
--   SELECT estudio_id, cuota_mensual_cop, features_crudas->'cuota_fianza_cop' AS fianza,
--          ingreso_inferido_ajustado_cop, dti_pct, dti_ajustado_pct
--     FROM public.estudios_scorecard_sombra ORDER BY fecha_calculo DESC LIMIT 10;
--   -- anon y authenticated sin acceso a la vista:
--   SELECT grantee, privilege_type FROM information_schema.role_table_grants
--    WHERE table_name = 'v_estudios_sombra_vs_real';
--
-- ROLLBACK (manual): repetir este archivo con las expresiones anteriores
--   dti_pct          = ROUND((cuota_mensual_cop / NULLIF(ingreso_inferido_cop, 0)) * 100, 2)
--   dti_ajustado_pct = ROUND((cuota_mensual_cop / NULLIF(ingreso_inferido_ajustado_cop, 0)) * 100, 2)
-- ------------------------------------------------------------
