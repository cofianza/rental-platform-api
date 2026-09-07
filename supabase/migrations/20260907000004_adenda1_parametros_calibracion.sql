-- ============================================================
-- Adenda 1 a la Politica V4.1 (Gerencia General, 07/09/2026)
-- ------------------------------------------------------------
-- 1) PANEL DE CALIBRACION (Adenda §11). "Todos estos valores deben poder
--    modificarse desde el panel de calibracion, sin intervencion de
--    desarrollo, unicamente por la Gerencia General, y todo cambio debe quedar
--    registrado con fecha, valor anterior, valor nuevo y usuario."
--
--    Una tabla de parametros numericos (clave -> valor) + su historial. Los
--    DEFAULTS viven en src/lib/calibracion.ts y se siembran aqui: si la tabla
--    no existe todavia, el codigo cae a los defaults sin romper nada.
--
-- 2) FACTOR_AJUSTE_INGRESO (Adenda §1.1). "Almacenamiento doble: el sistema
--    guarda siempre el ingreso crudo entregado por la central Y el ingreso
--    ajustado. Nunca sobrescribe el crudo. [...] el CRC y el log de la
--    evaluacion deben registrar el valor del factor aplicado."
--    -> columnas nuevas en estudios_scorecard_sombra. Las generadas existentes
--       (dti_pct, canon_ingreso_pct) siguen sobre el CRUDO; se agregan las
--       ajustadas, que son las que decide el motor.
--
-- 3) CASCADA (Adenda §2.4). "El CRC y el log deben indicar siempre que
--    centrales se consultaron y cual fue la decision de cascada aplicada."
--    -> estudios.proveedor_secundario / respuesta_proveedor_secundario /
--       cascada (JSONB con la traza).
--
-- 4) TARIFAS (Adenda §5, nota). "El sistema debe permitir sobrescribir la
--    tarifa con autorizacion de Gerencia General, dejando registro de quien
--    autorizo y cuando." -> estudios.tarifa_override (JSONB).
-- ============================================================

-- ── 1. Parametros de calibracion ─────────────────────────────

CREATE TABLE IF NOT EXISTS public.parametros_calibracion (
  clave            VARCHAR(60) PRIMARY KEY,
  valor            NUMERIC(14,4) NOT NULL,
  descripcion      TEXT,
  actualizado_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_por  UUID REFERENCES public.perfiles(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.parametros_calibracion IS
  'Parametros del modelo V4.1 + Adenda 1 editables desde el panel de calibracion (solo Gerencia). Defaults y validacion en src/lib/calibracion.ts. Todo cambio queda en parametros_calibracion_historial.';

CREATE TABLE IF NOT EXISTS public.parametros_calibracion_historial (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clave            VARCHAR(60) NOT NULL,
  valor_anterior   NUMERIC(14,4),
  valor_nuevo      NUMERIC(14,4) NOT NULL,
  usuario_id       UUID REFERENCES public.perfiles(id) ON DELETE SET NULL,
  motivo           TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_parametros_calibracion_historial_clave
  ON public.parametros_calibracion_historial (clave, created_at DESC);

-- Siembra con los valores de la Adenda §11. ON CONFLICT DO NOTHING: si
-- Gerencia ya movio un valor, esta migracion no lo pisa.
INSERT INTO public.parametros_calibracion (clave, valor, descripcion) VALUES
  ('FACTOR_AJUSTE_INGRESO',        1.15,    'Adenda §1.1 — multiplica el ingreso estimado por la central. Amplia de hecho las reglas duras (40% -> 46% real; 65% -> 74.7% real).'),
  ('UMBRAL_CASCADA_RECHAZO',       40,      'Adenda §2.1 — puntaje de la central primaria por debajo del cual se rechaza sin consultar la segunda.'),
  ('UMBRAL_CASCADA_APROBACION',    90,      'Adenda §2.1 — puntaje de la central primaria desde el cual se aprueba sin consultar la segunda.'),
  ('UMBRAL_DIFERENCIA_INGRESO',    50,      'Adenda §8 — % de diferencia entre ingreso declarado y estimado que levanta bandera de revision manual.'),
  ('VIGENCIA_CRC_DIAS',            60,      'Adenda §6 — vigencia del CRC en dias calendario desde la evaluacion.'),
  ('DIAS_EXPIRACION_ESTUDIO',      15,      'Adenda §9 — dias desde el envio de la solicitud al prospecto para que expire sin autorizar.'),
  ('UMBRAL_COARRENDATARIO',        80,      'Adenda §3 — puntaje minimo del COARRENDATARIO para aprobar automaticamente a un titular en zona gris (70-84).'),
  ('CANON_MAX_TRANSITORIO',        3000000, 'Politica §6 (regla transitoria) / Flujo §4.4 — canon maximo sin coafianzamiento, COP. Se siembra con el valor que ya corre en produccion (Flujo: 3.000.000); la Politica dice 2.000.000 — Gerencia decide.'),
  ('UMBRAL_APROBACION_AUTOMATICA', 85,      'Politica §3.1 — puntaje normalizado desde el cual se aprueba automaticamente.'),
  ('UMBRAL_ZONA_GRIS',             70,      'Politica §3.1 — puntaje normalizado desde el cual empieza la zona gris (70-84); por debajo, rechazo.')
ON CONFLICT (clave) DO NOTHING;

-- ── 2. Ingreso crudo vs ajustado en la fila sombra ─────────

ALTER TABLE public.estudios_scorecard_sombra
  ADD COLUMN IF NOT EXISTS ingreso_inferido_ajustado_cop NUMERIC(14,2)
    CHECK (ingreso_inferido_ajustado_cop IS NULL OR ingreso_inferido_ajustado_cop >= 0),
  ADD COLUMN IF NOT EXISTS factor_ajuste_ingreso NUMERIC(6,4)
    CHECK (factor_ajuste_ingreso IS NULL OR factor_ajuste_ingreso > 0),
  ADD COLUMN IF NOT EXISTS fuente_score_externo VARCHAR(20),
  ADD COLUMN IF NOT EXISTS scores_individuales JSONB;

ALTER TABLE public.estudios_scorecard_sombra
  ADD COLUMN IF NOT EXISTS dti_ajustado_pct NUMERIC(12,2) GENERATED ALWAYS AS (
    ROUND((cuota_mensual_cop / NULLIF(ingreso_inferido_ajustado_cop, 0)) * 100, 2)
  ) STORED,
  ADD COLUMN IF NOT EXISTS canon_ingreso_ajustado_pct NUMERIC(12,2) GENERATED ALWAYS AS (
    ROUND((canon_evaluado_cop / NULLIF(ingreso_inferido_ajustado_cop, 0)) * 100, 2)
  ) STORED;

COMMENT ON COLUMN public.estudios_scorecard_sombra.ingreso_inferido_ajustado_cop IS
  'Adenda §1.1: ingreso estimado por la central x FACTOR_AJUSTE_INGRESO. Es el que usan DTI y canon/ingreso (y sus reglas duras). El crudo sigue en ingreso_inferido_cop y nunca se sobrescribe.';
COMMENT ON COLUMN public.estudios_scorecard_sombra.factor_ajuste_ingreso IS
  'Adenda §1.1: factor vigente en el momento de ESTA evaluacion. Permite reconstruir con que valor se decidio cada caso aunque el parametro cambie despues.';
COMMENT ON COLUMN public.estudios_scorecard_sombra.fuente_score_externo IS
  'Politica §9: DATACREDITO | TRANSUNION | PROMEDIO | PERSISTIDO. Con cascada (Adenda §2) dice si el V1 salio de una central o del promedio de las dos.';

-- ── 3. Cascada: segunda central y traza ─────────────────────

ALTER TABLE public.estudios
  ADD COLUMN IF NOT EXISTS proveedor_secundario VARCHAR(20),
  ADD COLUMN IF NOT EXISTS respuesta_proveedor_secundario JSONB,
  ADD COLUMN IF NOT EXISTS cascada JSONB;

COMMENT ON COLUMN public.estudios.cascada IS
  'Adenda §2: traza de la consulta en cascada — central primaria, puntaje con ella, si se consulto la secundaria y por que, y la decision aplicada. NULL en estudios anteriores o con MOTOR_DECIDE_ENABLED apagado.';

-- ── 4. Tarifa negociada caso por caso ───────────────────────

ALTER TABLE public.estudios
  ADD COLUMN IF NOT EXISTS tarifa_override JSONB;

COMMENT ON COLUMN public.estudios.tarifa_override IS
  'Adenda §5 (nota): condiciones especiales que sobrescriben la tabla estandar. {tarifa_mensual_pct, prima_vinculacion_pct, cashback_pct, autorizado_por, autorizado_en, motivo}. NULL = tabla estandar.';

-- ── 5. Autorizacion sin OTP (Adenda §7) ─────────────────────
-- "No se implementa OTP en el flujo de autorizacion del estudio." El
-- prospecto acepta marcando las casillas (Decreto 1377/2013 art. 7), como ya
-- lo hace el co-arrendatario invitado. Nuevo metodo 'casilla'; 'otp' y
-- 'canvas' se conservan para las filas historicas.
ALTER TABLE public.autorizaciones_habeas_data
  DROP CONSTRAINT IF EXISTS autorizaciones_habeas_data_metodo_firma_check;
ALTER TABLE public.autorizaciones_habeas_data
  ADD CONSTRAINT autorizaciones_habeas_data_metodo_firma_check
  CHECK (metodo_firma IS NULL OR metodo_firma IN ('canvas', 'otp', 'casilla'));

-- ------------------------------------------------------------
-- ROLLBACK (manual)
--   DROP TABLE IF EXISTS public.parametros_calibracion_historial;
--   DROP TABLE IF EXISTS public.parametros_calibracion;
--   ALTER TABLE public.estudios_scorecard_sombra
--     DROP COLUMN IF EXISTS dti_ajustado_pct, DROP COLUMN IF EXISTS canon_ingreso_ajustado_pct,
--     DROP COLUMN IF EXISTS ingreso_inferido_ajustado_cop, DROP COLUMN IF EXISTS factor_ajuste_ingreso,
--     DROP COLUMN IF EXISTS fuente_score_externo, DROP COLUMN IF EXISTS scores_individuales;
--   ALTER TABLE public.estudios
--     DROP COLUMN IF EXISTS proveedor_secundario, DROP COLUMN IF EXISTS respuesta_proveedor_secundario,
--     DROP COLUMN IF EXISTS cascada, DROP COLUMN IF EXISTS tarifa_override;
