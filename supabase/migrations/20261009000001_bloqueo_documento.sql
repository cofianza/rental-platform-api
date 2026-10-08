-- ============================================================
-- Bloqueo por documento que no coincide (BLQ 07/10/2026, plan bloque 2).
--
-- 1. autorizacion_intentos_documento: cada número que digita el prospecto en
--    el enlace (BLQ §1 y §7). `valor_digitado` es un dato personal, posiblemente
--    de un tercero: SOLO lo lee la traza interna de Cofianza; nunca va al
--    logger, a la bitácora ni al timeline.
-- 2. correcciones_documento: cada corrección ciega del tipo/número de documento
--    con la fuente contra la que se verificó (BLQ §3.4, §3.6 y §7).
-- 3. autorizacion_envios: un registro por enlace emitido: si fue reenvío, el
--    resultado por canal (destino enmascarado) y por qué se cerró (BLQ §4 y §7).
--    «Vencido» no se guarda: se deriva al leer de token_expiracion.
--
-- No toca autorizaciones_habeas_data (su trigger de inalterabilidad lo impide)
-- ni el enum de estados del expediente: «bloqueado por documento», «identidad
-- rechazada» y «pendiente de reenvío» se derivan de estas tablas.
-- `coarrendatario_id` queda anulable para el bloque de varios coarrendatarios.
--
-- Solo SUMA tablas; no escribe datos existentes. Re-ejecutable (IF NOT EXISTS).
-- RLS habilitada SIN políticas y sin privilegios para anon ni authenticated:
-- solo la API (service_role) las lee y escribe. No crea funciones.
--
-- Verificación (solo lectura, después de correrla):
--   SELECT relname, relrowsecurity FROM pg_class
--    WHERE relname IN ('autorizacion_intentos_documento', 'correcciones_documento', 'autorizacion_envios')
--      AND relkind = 'r';                                                        -- 3 filas, todas true
--   SELECT count(*) FROM pg_policies
--    WHERE tablename IN ('autorizacion_intentos_documento', 'correcciones_documento', 'autorizacion_envios'); -- 0
--   SELECT has_table_privilege('anon', 'public.autorizacion_intentos_documento', 'SELECT'),
--          has_table_privilege('authenticated', 'public.correcciones_documento', 'SELECT'),
--          has_table_privilege('anon', 'public.autorizacion_envios', 'SELECT');  -- false, false, false
--
-- ROLLBACK (manual; borra la traza de intentos, correcciones y envíos):
--   DROP TABLE IF EXISTS public.autorizacion_intentos_documento,
--     public.correcciones_documento, public.autorizacion_envios;
-- ============================================================

BEGIN;

-- ── 1. Intentos del prospecto ──

CREATE TABLE IF NOT EXISTS public.autorizacion_intentos_documento (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  autorizacion_id    UUID NOT NULL REFERENCES public.autorizaciones_habeas_data(id) ON DELETE CASCADE,
  expediente_id      UUID REFERENCES public.expedientes(id) ON DELETE CASCADE,
  coarrendatario_id  UUID REFERENCES public.expediente_coarrendatarios(id) ON DELETE CASCADE,
  tipo_digitado      TEXT,
  valor_digitado     TEXT NOT NULL,
  coincide           BOOLEAN NOT NULL,
  origen             TEXT NOT NULL CHECK (origen IN ('confirmacion', 'firma')),
  ip                 TEXT,
  user_agent         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_autorizacion_intentos_documento_aut
  ON public.autorizacion_intentos_documento (autorizacion_id, coincide);
CREATE INDEX IF NOT EXISTS idx_autorizacion_intentos_documento_exp
  ON public.autorizacion_intentos_documento (expediente_id, created_at DESC);

-- ── 2. Correcciones ciegas del documento ──

CREATE TABLE IF NOT EXISTS public.correcciones_documento (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expediente_id        UUID NOT NULL REFERENCES public.expedientes(id) ON DELETE CASCADE,
  solicitante_id       UUID REFERENCES public.solicitantes(id) ON DELETE SET NULL,
  coarrendatario_id    UUID REFERENCES public.expediente_coarrendatarios(id) ON DELETE CASCADE,
  tipo_anterior        TEXT,
  numero_anterior      TEXT,
  tipo_nuevo           TEXT NOT NULL,
  numero_nuevo         TEXT NOT NULL,
  fuente_verificacion  TEXT NOT NULL
                         CHECK (fuente_verificacion IN ('documento_fisico', 'copia_documento', 'confirmacion_telefonica')),
  usuario_id           UUID REFERENCES public.perfiles(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_correcciones_documento_exp
  ON public.correcciones_documento (expediente_id, created_at DESC);

-- ── 3. Enlaces emitidos ──

CREATE TABLE IF NOT EXISTS public.autorizacion_envios (
  autorizacion_id    UUID PRIMARY KEY REFERENCES public.autorizaciones_habeas_data(id) ON DELETE CASCADE,
  expediente_id      UUID REFERENCES public.expedientes(id) ON DELETE CASCADE,
  coarrendatario_id  UUID REFERENCES public.expediente_coarrendatarios(id) ON DELETE CASCADE,
  generado_por       UUID REFERENCES public.perfiles(id) ON DELETE SET NULL,
  es_reenvio         BOOLEAN NOT NULL DEFAULT false,
  -- [{ canal, destino_enmascarado, estado, error? }]
  envios             JSONB NOT NULL DEFAULT '[]'::jsonb,
  motivo_cierre      TEXT CHECK (motivo_cierre IN ('intentos', 'no_soy_yo', 'datos_incorrectos', 'reemplazado', 'correccion')),
  cerrado_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_autorizacion_envios_exp
  ON public.autorizacion_envios (expediente_id, created_at DESC);
-- Banner de bloqueos pendientes: solo los cerrados por documento.
CREATE INDEX IF NOT EXISTS idx_autorizacion_envios_bloqueo
  ON public.autorizacion_envios (cerrado_at DESC)
  WHERE motivo_cierre IN ('intentos', 'datos_incorrectos');

-- ── 4. Solo la API ──

ALTER TABLE public.autorizacion_intentos_documento ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.correcciones_documento ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.autorizacion_envios ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.autorizacion_intentos_documento FROM anon, authenticated;
REVOKE ALL ON public.correcciones_documento FROM anon, authenticated;
REVOKE ALL ON public.autorizacion_envios FROM anon, authenticated;

COMMIT;
