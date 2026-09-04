-- ============================================================
-- estudios.regla_dura_activada — trazabilidad de las reglas duras que DECIDEN
-- ------------------------------------------------------------
-- POR QUE
--
-- Gerencia autorizo el 2026-09-03 activar DOS reglas duras de la Politica de
-- Evaluacion V4.1, literales en sus tablas:
--
--   §4.2 Capacidad de endeudamiento (DTI): "> 65%  ->  RECHAZO AUTOMATICO"
--   §4.3 Relacion canon / ingreso:         "> 40%  ->  RECHAZO AUTOMATICO"
--
-- y §3: "Las reglas duras anulan el puntaje total y generan rechazo automatico
-- sin importar cuantos puntos tenga el solicitante en las demas variables".
--
-- Caso que lo motivo (produccion, 2026-09-02, estudio fca479e0): score 773,
-- ingreso inferido 5.094.000, cuota vigente 4.081.000 (DTI 80,11%), canon
-- 3.800.000 (canon/ingreso 74,60%). El sistema lo aprobo automaticamente.
--
-- ------------------------------------------------------------
-- POR QUE UNA COLUMNA Y NO SOLO motivo_rechazo
--
-- `motivo_rechazo` ya guarda el texto con las cifras para el gestor, y
-- `estudios_scorecard_sombra` guarda la corrida completa. Lo que ninguno de los
-- dos resuelve es la medicion agregada:
--
--   Gerencia pidio medir el impacto. Con un TEXT[] indexable eso es una linea:
--     SELECT unnest(regla_dura_activada) AS regla, COUNT(*)
--       FROM estudios WHERE regla_dura_activada IS NOT NULL GROUP BY 1;
--   Sobre texto libre no lo es.
--
-- LO QUE ESTA COLUMNA **NO** SOSTIENE
--
-- Ningun texto que ve una persona depende de ella. El orquestador y la
-- ponderacion del co-arrendatario reciben el veredicto EN MEMORIA por el hook
-- post-resultado (dispararHookPostResultado -> onEstudioCompletado /
-- onCoarrendatarioEstudioCompletado), y su respaldo es el marcador
-- "Rechazo automatico por regla dura..." al inicio de motivo_rechazo. Se hizo
-- asi a proposito: atar el copy a esta columna significaba que, entre el deploy
-- y la migracion, todo rechazo por regla dura volviera a decirle al prospecto
-- "no cumplio los requisitos minimos" junto a su score de 773 — exactamente el
-- mensaje que la activacion existe para eliminar.
--
-- ------------------------------------------------------------
-- SEMANTICA
--
--   NULL  -> ninguna regla dura decidio este estudio. Es el 100% del historico
--            y sigue siendo el caso normal: con TransUnion, que no entrega
--            ingreso inferido, NINGUNA de las dos reglas es evaluable.
--   {...} -> los codigos de las reglas que forzaron el rechazo. Los codigos son
--            los mismos de CodigoReglaDura en motor/scorecard.ts y se persisten
--            tal cual: agregar si, renombrar no (invalidaria el historico).
--
-- Un array vacio NO es un estado valido: si ninguna regla se activo la columna
-- queda NULL. El CHECK lo impone para que `IS NOT NULL` sea suficiente para
-- filtrar, sin tener que acordarse de mirar tambien cardinality().
--
-- NO se rellena hacia atras: el estudio fca479e0 y los demas historicos se
-- decidieron con la regla apagada y su fila debe seguir contando eso. El cruce
-- contrafactual (que HABRIA pasado) ya vive en estudios_scorecard_sombra.
--
-- Escritura: un UPDATE aparte, inmediatamente despues de
-- fn_registrar_resultado_estudio (mismo patron que respuesta_proveedor). La
-- firma del RPC no cambia — asi el codigo puede desplegarse antes o despues de
-- esta migracion sin coordinar: si la columna no existe todavia, el UPDATE
-- falla, se registra un warning y el rechazo queda igual, con su motivo en
-- motivo_rechazo y con los mismos textos para gestor y prospecto.
--
-- ------------------------------------------------------------
-- POR QUE ESTA VERSION Y NO 20260903000002
--
-- La 20260903000002 ya la ocupa 20260903000002_autorizacion_previa_evidencia.
-- El CLI de Supabase indexa por el PREFIJO de version, no por el nombre: con
-- dos archivos en la misma version aplica uno, da la version por hecha y el
-- otro no vuelve a intentarse nunca. La 000003 tambien esta tomada
-- (vigencia_certificado_60_dias), asi que esta migracion toma la 000004.
-- ============================================================

ALTER TABLE public.estudios
  ADD COLUMN IF NOT EXISTS regla_dura_activada TEXT[];

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_estudios_regla_dura_activada'
  ) THEN
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
            'mora_mayor_30d_6m'
          ]::TEXT[]
        )
      );
  END IF;
END $$;

COMMENT ON COLUMN public.estudios.regla_dura_activada IS
  'Codigos de las reglas duras de la Politica V4.1 que forzaron resultado=rechazado, anulando el puntaje (§3). NULL cuando ninguna decidio. Hoy solo dos estan ACTIVAS en el codigo (dti_mayor_65 §4.2 y canon_ingreso_mayor_40 §4.3, ver REGLAS_DURAS_ACTIVAS en src/modules/estudios/reglas-duras.ts); las demas se calculan en sombra y no deciden. El CHECK acepta el vocabulario completo para no tener que alterarlo cuando Gerencia autorice otra.';

-- Indice parcial: la consulta de impacto es siempre "los que SI activaron una
-- regla", que son una minoria. El indice parcial pesa lo que esa minoria.
CREATE INDEX IF NOT EXISTS idx_estudios_regla_dura_activada
  ON public.estudios USING GIN (regla_dura_activada)
  WHERE regla_dura_activada IS NOT NULL;

-- ------------------------------------------------------------
-- ROLLBACK (manual, no se ejecuta aqui)
--
--   DROP INDEX IF EXISTS public.idx_estudios_regla_dura_activada;
--   ALTER TABLE public.estudios
--     DROP CONSTRAINT IF EXISTS chk_estudios_regla_dura_activada;
--   ALTER TABLE public.estudios DROP COLUMN IF EXISTS regla_dura_activada;
--
-- Quitar la columna NO reactiva a nadie: los estudios ya rechazados siguen
-- rechazados. Para revertir la DECISION hay que vaciar REGLAS_DURAS_ACTIVAS en
-- reglas-duras.ts, que es donde vive la autorizacion de Gerencia.
-- ------------------------------------------------------------
