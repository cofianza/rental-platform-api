-- ============================================================
-- Scorecard V4.1 en MODO SOMBRA — features del buro + resultado del motor
-- ------------------------------------------------------------
-- POR QUE
--
-- Gerencia entrego la "Politica de Evaluacion y Aprobacion por Score V4.1":
-- un scorecard aditivo de 9 variables, 119 puntos brutos normalizados a 100,
-- con umbrales 85 (aprobado) / 70 (revision manual). Con las fuentes
-- contratadas HOY el techo alcanzable es 80.7 puntos con DataCredito y 59.7
-- con TransUnion: aplicar esos umbrales a la decision real rechazaria a toda
-- la cartera.
--
-- Por eso esta migracion NO cambia ninguna decision. Habilita unicamente
-- persistir, en paralelo, (a) las features que el buro ya nos manda y hoy
-- botamos, y (b) lo que el motor V4.1 HABRIA decidido. Con eso Gerencia puede
-- medir el impacto real antes de mover un solo umbral:
--
--   -- cuantos de los que hoy aprobamos caerian en revision manual
--   SELECT decision_real, decision_sombra, COUNT(*)
--     FROM v_estudios_sombra_vs_real
--    WHERE modelo_version = 'v4.1-sombra-6var'
--    GROUP BY 1, 2;
--
-- NADA aqui toca la ruta de decision vigente: fn_registrar_resultado_estudio
-- conserva su firma y su cuerpo, el enum resultado_estudio no cambia, y la
-- columna estudios.resultado sigue siendo la unica verdad operativa.
--
-- ------------------------------------------------------------
-- DECISION DE DISENO: MIXTO (2 columnas en estudios + 1 tabla hija)
--
-- 1) El canon evaluado va en `estudios`, NO en la tabla del scorecard.
--    Hoy el canon solo vive en inmuebles.valor_arriendo, que es editable: si
--    el gestor lo sube el mes que viene, el DTI y el ratio canon/ingreso de
--    todos los estudios historicos mienten hacia atras, y el certificado (que
--    es portable a otro inmueble) deja de decir para que canon se aprobo.
--    Congelarlo es un hecho del ESTUDIO, no del modelo: sobrevive a cualquier
--    version del scorecard y debe seguir ahi aunque el motor sombra se apague.
--
-- 2) Todo lo demas —features extraidas y salida del motor— va en la tabla
--    hija `estudios_scorecard_sombra`, no en columnas de `estudios`. Razones:
--      - `estudios` ya pasa de 25 columnas y esta en la ruta caliente (lista,
--        detalle y el estudio_vigente que devuelve fn_list_expedientes).
--        Sumarle ~25 columnas nullable ensancha cada lectura del flujo real
--        para servir a un experimento.
--      - El modelo va a iterar (v4.1 -> v4.2 -> v5) y con el cambia tambien el
--        extractor. Esa rotacion de DDL debe ocurrir en una tabla apendice, no
--        en la tabla cuyo ALTER bloquea el registro de resultados.
--      - Aislamiento estructural del modo sombra: el escritor del scorecard
--        solo hace INSERT en esta tabla. Es fisicamente incapaz de tocar
--        `resultado`. Y el nombre lleva "sombra" a proposito: quien escriba
--        JOIN estudios_scorecard_sombra para decidir algo sabe que esta
--        haciendo algo indebido.
--      - Recalcular el modelo sobre el historico es un INSERT de una version
--        nueva en una sola tabla, sin riesgo de reescribir decisiones.
--      - ON DELETE CASCADE => fn_wipe_solo_datos / fn_wipe_test_data siguen
--        funcionando sin tocarlas (el DELETE FROM estudios arrastra las filas).
--
-- 3) Dentro de la tabla hija: columnas dedicadas para lo que se agrega,
--    filtra u ordena (features numericas, puntajes, decision, ratios) y JSONB
--    solo para lo que se lee de a un estudio (detalle por variable, bag crudo
--    de extraccion). La pregunta que motiva todo esto es un cruce agregado:
--    en JSONB obliga a castear en cada fila y no se puede indexar util.
--
-- 4) La fila es un REGISTRO DE CORRIDA inmutable: snapshotea todos sus
--    insumos, incluidos canon y umbrales. Un puntaje sin el umbral con el que
--    se comparo no se puede reinterpretar seis meses despues.
--
-- 5) Sufijo _cop en los montos a proposito. El bug historico de esta
--    integracion es miles-vs-pesos (agregatedInfo viene en MILES, el detalle
--    de liabilities en PESOS). La unidad va en el nombre para que el error no
--    se pueda cometer en silencio. Los centinelas -1 y '-' del buro significan
--    "no reporta" y se guardan como NULL, nunca como 0.
--
-- 6) decision_sombra es TEXT + CHECK, NO el enum resultado_estudio. Dos
--    motivos: la banda intermedia de la politica es "revision manual" (no
--    "condicionado") y hace falta un cuarto valor "no_calculable" para cuando
--    faltan insumos; y reusar el enum de decision invitaria a cablear esta
--    columna a la decision real. La pared de tipos es deliberada.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Canon congelado en el estudio
-- ------------------------------------------------------------
-- Ambas columnas son nullable y sin default: las filas existentes no se
-- reescriben y ningun INSERT actual se rompe.
--
-- OJO — quien escribe estas dos columnas NO es el motor sombra. Congelar el
-- canon pertenece a la ruta REAL de ejecucion del estudio (antes de llamar al
-- buro), y hacerlo desde el motor obligaria al modulo sombra a escribir en
-- `estudios`, rompiendo justo la garantia que lo hace seguro: que solo puede
-- INSERTAR en la tabla de abajo y es fisicamente incapaz de tocar `resultado`.
-- Mientras esa ruta no lo escriba, `estudios.canon_evaluado` queda NULL y el
-- canon que uso cada corrida vive en
-- estudios_scorecard_sombra.canon_evaluado_cop (y en canon_ingreso_pct, que es
-- lo que el analisis realmente consulta).

-- Los CHECK van nombrados y aparte de la columna: 'ADD COLUMN IF NOT EXISTS'
-- con un CHECK inline NO es idempotente — al correr la migracion dos veces
-- Postgres agrega un segundo constraint con nombre autogenerado.
ALTER TABLE public.estudios
  ADD COLUMN IF NOT EXISTS canon_evaluado        NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS canon_evaluado_origen VARCHAR(20);

DO $$
BEGIN
  ALTER TABLE public.estudios ADD CONSTRAINT chk_estudios_canon_evaluado
    CHECK (canon_evaluado IS NULL OR canon_evaluado > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE public.estudios ADD CONSTRAINT chk_estudios_canon_evaluado_origen
    CHECK (canon_evaluado_origen IS NULL OR canon_evaluado_origen IN (
      'inmueble', 'contrato', 'expediente', 'manual'
    ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN public.estudios.canon_evaluado IS
  'PENDIENTE DE USO: hoy ningun codigo la escribe (el motor sombra guarda su canon en estudios_scorecard_sombra.canon_evaluado_cop). Canon mensual (COP) congelado en el momento del estudio. inmuebles.valor_arriendo es editable: sin este snapshot el DTI historico y la portabilidad del certificado mienten. Se escribe una sola vez, al ejecutar el estudio.';

COMMENT ON COLUMN public.estudios.canon_evaluado_origen IS
  'De donde se tomo canon_evaluado: inmueble (valor_arriendo), contrato, expediente (datos_contrato) o manual. Explica por que el canon congelado difiere del canon actual del inmueble.';


-- ------------------------------------------------------------
-- 2. Tabla del motor sombra
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.estudios_scorecard_sombra (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  estudio_id                  UUID NOT NULL
                                REFERENCES public.estudios(id) ON DELETE CASCADE,

  -- ── Identidad de la corrida ──────────────────────────────
  -- modelo_version cubre scorecard + extractor: si cambia como se leen las
  -- features, cambia la version, aunque los pesos sigan iguales.
  modelo_version              VARCHAR(20)  NOT NULL,
  fecha_calculo               TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- ── Score externo (V1, 50 pts) ───────────────────────────
  -- Se snapshotea aparte de estudios.score porque los cortes de V1 dependen
  -- del modelo que lo produjo (DataCredito devuelve varios en models[]; hoy
  -- se toma el de modelCode 'DF', escala 0-1000). Sin esa etiqueta el numero
  -- no es comparable entre buros.
  score_externo               INTEGER,
  score_externo_modelo        VARCHAR(40),

  -- ── Capacidad de pago (V2 DTI 15 pts, V3 canon/ingreso 10 pts) ──
  -- TransUnion NO entrega ingreso inferido: por esa via ingreso_inferido_cop
  -- queda NULL y V2/V3 quedan no calculables. NULL != 0.
  ingreso_inferido_cop        NUMERIC(14,2)
                                CHECK (ingreso_inferido_cop IS NULL OR ingreso_inferido_cop >= 0),
  cuota_mensual_cop           NUMERIC(14,2)
                                CHECK (cuota_mensual_cop IS NULL OR cuota_mensual_cop >= 0),
  -- Copia del canon que ESTA corrida uso. estudios.canon_evaluado es el hecho
  -- de negocio; esto es el insumo del modelo. Normalmente identicos; si algun
  -- dia difieren, la diferencia misma es el hallazgo.
  canon_evaluado_cop          NUMERIC(12,2)
                                CHECK (canon_evaluado_cop IS NULL OR canon_evaluado_cop > 0),

  -- Ratios derivados: STORED y no calculados por la app, para que no puedan
  -- contradecir a sus insumos. NULLIF evita la division por cero y propaga
  -- NULL cuando el buro no reporto ingreso.
  -- NUMERIC(12,2), no (7,2): ambos ratios se derivan de columnas NUMERIC(14,2),
  -- asi que un ingreso muy bajo frente a una cuota alta puede superar el tope
  -- de 99999.99. Al ser GENERATED la app no puede encuadrarlos, y el desborde
  -- tumbaria el INSERT entero — perdiendo tambien el resto de la evaluacion.
  dti_pct                     NUMERIC(12,2) GENERATED ALWAYS AS (
                                ROUND((cuota_mensual_cop / NULLIF(ingreso_inferido_cop, 0)) * 100, 2)
                              ) STORED,
  canon_ingreso_pct           NUMERIC(12,2) GENERATED ALWAYS AS (
                                ROUND((canon_evaluado_cop / NULLIF(ingreso_inferido_cop, 0)) * 100, 2)
                              ) STORED,

  -- ── Endeudamiento y mora ─────────────────────────────────
  saldo_total_cop             NUMERIC(14,2)
                                CHECK (saldo_total_cop IS NULL OR saldo_total_cop >= 0),
  saldo_mora_cop              NUMERIC(14,2)
                                CHECK (saldo_mora_cop IS NULL OR saldo_mora_cop >= 0),
  obligaciones_vigentes       SMALLINT
                                CHECK (obligaciones_vigentes IS NULL OR obligaciones_vigentes >= 0),
  obligaciones_negativas      SMALLINT
                                CHECK (obligaciones_negativas IS NULL OR obligaciones_negativas >= 0),
  -- Sustenta las reglas duras de mora vigente; sin el, una regla dura
  -- activada no es auditable.
  mora_maxima_dias            SMALLINT
                                CHECK (mora_maxima_dias IS NULL OR mora_maxima_dias >= 0),

  -- ── Experiencia crediticia (V5, 6 pts) ───────────────────
  -- Conjunto de sectores presentes, normalizado (financiero, cooperativo,
  -- telco, real, ...). TEXT[] y no JSONB: V5 puntua la PRESENCIA y el conteo
  -- de sectores distintos, y un array se indexa con GIN. El conteo de
  -- obligaciones por sector va en features_crudas.
  sectores                    TEXT[] NOT NULL DEFAULT '{}',

  -- ── Antiguedad del historial (V8, 5 pts) ─────────────────
  fecha_primera_obligacion    DATE,
  -- Se almacena en vez de derivarse: age() no es inmutable, y la antiguedad
  -- correcta es la que habia en fecha_calculo, no la de hoy.
  antiguedad_historial_meses  INTEGER
                                CHECK (antiguedad_historial_meses IS NULL OR antiguedad_historial_meses >= 0),

  -- ── Comportamiento reciente (V6, 10 pts) ─────────────────
  -- Meses con marca de mora en cada ventana de la politica.
  meses_con_mora_24m          SMALLINT CHECK (meses_con_mora_24m IS NULL OR meses_con_mora_24m BETWEEN 0 AND 24),
  meses_con_mora_12m          SMALLINT CHECK (meses_con_mora_12m IS NULL OR meses_con_mora_12m BETWEEN 0 AND 12),
  meses_con_mora_6m           SMALLINT CHECK (meses_con_mora_6m  IS NULL OR meses_con_mora_6m  BETWEEN 0 AND 6),
  -- Cuantos meses de comportamiento reporto REALMENTE el buro. Cero moras
  -- sobre 3 meses no es lo mismo que cero moras sobre 24; sin este campo los
  -- puntos de V6 son ininterpretables.
  ventana_comportamiento_meses SMALLINT
                                CHECK (ventana_comportamiento_meses IS NULL OR ventana_comportamiento_meses BETWEEN 0 AND 24),

  -- ── Salida del motor ─────────────────────────────────────
  puntaje_bruto               NUMERIC(6,2) CHECK (puntaje_bruto IS NULL OR puntaje_bruto >= 0),
  puntaje_normalizado         NUMERIC(6,2) CHECK (puntaje_normalizado IS NULL OR puntaje_normalizado BETWEEN 0 AND 100),
  -- Techo alcanzable con las fuentes disponibles en esta corrida (~80.7 con
  -- DataCredito, ~59.7 con TransUnion). Es la columna que distingue un
  -- solicitante malo de uno con fuentes pobres: sin ella un 62 normalizado no
  -- se puede leer.
  puntaje_maximo_alcanzable   NUMERIC(6,2) CHECK (puntaje_maximo_alcanzable IS NULL OR puntaje_maximo_alcanzable BETWEEN 0 AND 100),

  -- Umbrales efectivamente usados (hoy 85 / 70). Se guardan porque cuando
  -- Gerencia los mueva, las filas viejas deben seguir siendo explicables.
  umbral_aprobado             NUMERIC(5,2),
  umbral_revision             NUMERIC(5,2),

  -- Lo que el motor HABRIA decidido. NO se aplica en ningun lado.
  decision_sombra             VARCHAR(20) NOT NULL
                                CHECK (decision_sombra IN (
                                  'aprobado', 'revision_manual', 'rechazado', 'no_calculable'
                                )),
  motivo_no_calculable        TEXT,

  -- Reglas duras de rechazo que se habrian activado, en codigos estables
  -- ('mora_vigente', 'dti_excedido', ...). Array + GIN para poder responder
  -- "cuantos caen por cada regla" sin desarmar JSONB.
  reglas_duras_activadas      TEXT[] NOT NULL DEFAULT '{}',
  -- Variables sin fuente en esta corrida ('V4','V7','V9' hoy siempre; 'V2',
  -- 'V3' ademas cuando el buro es TransUnion). Es la medicion directa de la
  -- brecha de fuentes.
  variables_no_calculables    TEXT[] NOT NULL DEFAULT '{}',

  -- ── Detalle (lectura de a un estudio, nunca agregada) ────
  -- {"V1": {"valor": 972, "puntos": 50, "max": 50}, ...}
  puntaje_por_variable        JSONB NOT NULL DEFAULT '{}'::JSONB,
  -- Bag crudo de la extraccion: conteo de obligaciones por sector, cadena de
  -- comportamiento, rutas del payload usadas. Provenance para poder auditar
  -- una cifra sin volver a parsear respuesta_proveedor.
  features_crudas             JSONB NOT NULL DEFAULT '{}'::JSONB,

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Una corrida por (estudio, version del modelo). Permite recalcular el
  -- historico con v4.2 sin perder lo que dijo v4.1.
  CONSTRAINT uq_scorecard_sombra_estudio_modelo UNIQUE (estudio_id, modelo_version),

  -- Coherencia: o hay puntaje, o la decision es no_calculable. Evita filas
  -- "aprobado con puntaje NULL" que envenenarian el cruce agregado.
  CONSTRAINT chk_scorecard_sombra_no_calculable CHECK (
    (decision_sombra =  'no_calculable' AND puntaje_normalizado IS NULL)
    OR
    (decision_sombra <> 'no_calculable' AND puntaje_normalizado IS NOT NULL)
  )
);


-- ------------------------------------------------------------
-- 3. Indices — orientados al cruce sombra vs real
-- ------------------------------------------------------------

-- La consulta que motiva la tabla: cruzar decision real contra decision
-- sombra dentro de una version del modelo. Con INCLUDE el lado del scorecard
-- se resuelve index-only y el JOIN entra a estudios por su PK.
CREATE INDEX IF NOT EXISTS idx_scorecard_sombra_modelo_decision
  ON public.estudios_scorecard_sombra (modelo_version, decision_sombra)
  INCLUDE (estudio_id, puntaje_normalizado);

-- uq_scorecard_sombra_estudio_modelo ya cubre el lookup por estudio_id
-- (columna lider), asi que no hace falta un indice adicional para el FK.

-- "cuantos caen por cada regla dura" / "cuantos por mora vigente".
CREATE INDEX IF NOT EXISTS idx_scorecard_sombra_reglas_duras
  ON public.estudios_scorecard_sombra USING GIN (reglas_duras_activadas);

-- "cuantos se puntuaron sin V2" — la medicion de la brecha de fuentes.
CREATE INDEX IF NOT EXISTS idx_scorecard_sombra_variables_faltantes
  ON public.estudios_scorecard_sombra USING GIN (variables_no_calculables);


-- ------------------------------------------------------------
-- 4. RLS
-- ------------------------------------------------------------
-- Misma postura que `estudios`: RLS habilitada sin politicas. La API usa
-- service_role (bypassa RLS) y el aislamiento multi-tenant se aplica en capa
-- de aplicacion; esto solo evita que la tabla quede expuesta via PostgREST
-- con la anon key. Contiene features derivadas de datos de buro.

ALTER TABLE public.estudios_scorecard_sombra ENABLE ROW LEVEL SECURITY;


-- ------------------------------------------------------------
-- 5. Vista de analisis
-- ------------------------------------------------------------
-- Puerta de entrada para Gerencia. Solo lectura, solo estudios ya resueltos.
--
--   SELECT decision_real, decision_sombra, COUNT(*)
--     FROM v_estudios_sombra_vs_real
--    WHERE modelo_version = 'v4.1-sombra-6var'
--    GROUP BY 1, 2
--    ORDER BY 1, 2;
--
--   -- desglosado por buro, que es donde vive la brecha de fuentes
--   SELECT proveedor, decision_real, decision_sombra,
--          COUNT(*), ROUND(AVG(puntaje_normalizado), 1) AS score_medio,
--          ROUND(AVG(puntaje_maximo_alcanzable), 1)     AS techo_medio
--     FROM v_estudios_sombra_vs_real
--    WHERE modelo_version = 'v4.1-sombra-6var' AND decision_real = 'aprobado'
--    GROUP BY 1, 2, 3;

CREATE OR REPLACE VIEW public.v_estudios_sombra_vs_real AS
SELECT
  e.id                          AS estudio_id,
  e.expediente_id,
  e.proveedor,
  e.tipo                        AS tipo_estudio,
  e.resultado                   AS decision_real,
  e.score                       AS score_proveedor,
  e.fecha_completado,
  -- Hoy siempre NULL: congelar el canon en el estudio pertenece a la ruta real
  -- de ejecucion, no al motor sombra. Se deja expuesto con nombre explicito
  -- para cuando esa ruta lo escriba.
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
  s.fecha_calculo
FROM public.estudios e
JOIN public.estudios_scorecard_sombra s ON s.estudio_id = e.id
WHERE e.resultado <> 'pendiente';

-- La vista pertenece al owner de la migracion, asi que no hereda la RLS de
-- las tablas base. Se le quita el acceso a los roles del cliente: solo
-- service_role (la API) la lee.
REVOKE ALL ON public.v_estudios_sombra_vs_real FROM PUBLIC;
REVOKE ALL ON public.v_estudios_sombra_vs_real FROM anon, authenticated;


-- ------------------------------------------------------------
-- 6. Comentarios
-- ------------------------------------------------------------

COMMENT ON TABLE public.estudios_scorecard_sombra IS
  'MODO SOMBRA: features extraidas del buro + resultado del scorecard V4.1 que NO se aplica. La decision operativa sigue siendo estudios.resultado. Una fila por (estudio, modelo_version); la fila es un registro de corrida inmutable que snapshotea sus propios insumos y umbrales.';

COMMENT ON COLUMN public.estudios_scorecard_sombra.modelo_version IS
  'Version de scorecard + extractor (ej. v4.1-sombra-6var). Cambia tambien si cambia como se leen las features, aunque los pesos sigan iguales.';
COMMENT ON COLUMN public.estudios_scorecard_sombra.score_externo IS
  'V1: score del buro usado por el modelo. Se snapshotea aparte de estudios.score porque los cortes de V1 dependen del modelo que lo produjo.';
COMMENT ON COLUMN public.estudios_scorecard_sombra.score_externo_modelo IS
  'Identificador del modelo del buro (ej. DataCredito modelCode DF, escala 0-1000). Sin el, los scores no son comparables entre proveedores.';
COMMENT ON COLUMN public.estudios_scorecard_sombra.ingreso_inferido_cop IS
  'V2/V3: ingreso mensual inferido en PESOS. NULL cuando el buro no lo reporta (TransUnion nunca lo entrega). NULL no es 0.';
COMMENT ON COLUMN public.estudios_scorecard_sombra.cuota_mensual_cop IS
  'V2: cuota mensual comprometida en PESOS. Los agregados del buro vienen en MILES; se convierten antes de guardar.';
COMMENT ON COLUMN public.estudios_scorecard_sombra.canon_evaluado_cop IS
  'V3: canon que uso esta corrida. Copia de estudios.canon_evaluado en el momento del calculo.';
COMMENT ON COLUMN public.estudios_scorecard_sombra.dti_pct IS
  'V2: cuota / ingreso * 100. Columna generada (STORED) para que no pueda contradecir sus insumos. NULL si falta ingreso.';
COMMENT ON COLUMN public.estudios_scorecard_sombra.canon_ingreso_pct IS
  'V3: canon / ingreso * 100. Columna generada (STORED). NULL si falta ingreso.';
COMMENT ON COLUMN public.estudios_scorecard_sombra.sectores IS
  'V5: sectores economicos presentes, normalizados (financiero, cooperativo, telco, real...). El conteo por sector va en features_crudas.';
COMMENT ON COLUMN public.estudios_scorecard_sombra.ventana_comportamiento_meses IS
  'V6: meses de comportamiento realmente reportados por el buro. Cero moras sobre 3 meses no equivale a cero moras sobre 24.';
COMMENT ON COLUMN public.estudios_scorecard_sombra.puntaje_maximo_alcanzable IS
  'Techo normalizado dadas las fuentes disponibles en esta corrida (~80.7 DataCredito, ~59.7 TransUnion). Distingue un solicitante malo de uno con fuentes pobres.';
COMMENT ON COLUMN public.estudios_scorecard_sombra.decision_sombra IS
  'Decision que el motor V4.1 HABRIA tomado. NO se aplica: es TEXT y no resultado_estudio a proposito, para que no se pueda cablear a la decision real.';
COMMENT ON COLUMN public.estudios_scorecard_sombra.reglas_duras_activadas IS
  'Codigos estables de las reglas duras de rechazo que se habrian activado. Vacio = ninguna.';
COMMENT ON COLUMN public.estudios_scorecard_sombra.variables_no_calculables IS
  'Variables sin fuente en esta corrida. Hoy siempre V4/V7/V9; ademas V2/V3 cuando el buro es TransUnion.';
COMMENT ON COLUMN public.estudios_scorecard_sombra.puntaje_por_variable IS
  'Detalle por variable: {"V1": {"valor": 972, "puntos": 50, "max": 50}, ...}. Se lee de a un estudio, nunca agregado.';
COMMENT ON COLUMN public.estudios_scorecard_sombra.features_crudas IS
  'Bag crudo de la extraccion (obligaciones por sector, cadena de comportamiento, rutas del payload usadas). Provenance para auditar sin reparsear respuesta_proveedor.';

COMMENT ON VIEW public.v_estudios_sombra_vs_real IS
  'Cruce solo-lectura decision real vs decision sombra por estudio. Responde "cuantos de los que hoy aprobamos caerian en revision manual". No la consuma ningun flujo transaccional.';


-- ============================================================
-- ROLLBACK (no ejecutar como parte de esta migracion)
-- ------------------------------------------------------------
-- DROP VIEW IF EXISTS public.v_estudios_sombra_vs_real;
--
-- DROP INDEX IF EXISTS public.idx_scorecard_sombra_variables_faltantes;
-- DROP INDEX IF EXISTS public.idx_scorecard_sombra_reglas_duras;
-- DROP INDEX IF EXISTS public.idx_scorecard_sombra_modelo_decision;
--
-- DROP TABLE IF EXISTS public.estudios_scorecard_sombra;
--
-- ALTER TABLE public.estudios
--   DROP CONSTRAINT IF EXISTS estudios_canon_evaluado_check,
--   DROP CONSTRAINT IF EXISTS estudios_canon_evaluado_origen_check;
--
-- ALTER TABLE public.estudios
--   DROP COLUMN IF EXISTS canon_evaluado_origen,
--   DROP COLUMN IF EXISTS canon_evaluado;
--
-- OJO: revertir borra el canon congelado de los estudios ya ejecutados, que
-- no se puede reconstruir (inmuebles.valor_arriendo ya pudo cambiar). Si solo
-- se quiere apagar el motor sombra, basta con dejar de escribir en
-- estudios_scorecard_sombra: nada del flujo real lee esta tabla.
-- ============================================================
