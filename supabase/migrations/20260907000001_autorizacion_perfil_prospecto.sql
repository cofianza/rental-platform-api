-- ============================================================
-- PASO 5 del Flujo de Gerencia (modulo de estudios, §8): lo que el PROSPECTO
-- declara en su celular en la pantalla de autorizacion, antes de firmar.
--
-- Flujo §8, literal:
--   §8.1 "Se muestran el nombre y el documento registrados para que el
--         prospecto los confirme o corrija. Si los datos no corresponden a esa
--         persona, debe existir una opcion para reportarlo y detener el
--         proceso."
--   §8.2 "Situacion laboral. Empleado, independiente, pensionado, otro. [...]
--         Donde labora. [...] Ingresos mensuales. [...] aclarar que NO SE
--         COMPARTE CON LA INMOBILIARIA."
--   §8.3 "El prospecto indica si presentara la solicitud solo o con un
--         coarrendatario."
--
-- ── QUE HACE ESTA MIGRACION ──────────────────────────────────────────────
--
-- UNA tabla, 1:1 con el expediente. Nada mas. Ni columnas nuevas en otras
-- tablas, ni valores nuevos en ningun enum, ni funciones tocadas.
--
-- ── QUE NO HACE, Y POR QUE ───────────────────────────────────────────────
--
-- 1) NO agrega columnas a `autorizaciones_habeas_data`.
--    fn_autorizaciones_habeas_data_inalterable (20260903000002) es una
--    ALLOWLIST: en la firma solo se pueden escribir las 15 columnas de
--    `k_firma`, y sobre una fila 'pendiente' el UNICO UPDATE admitido es
--    pasarla a 'expirado' cambiando exclusivamente `estado`. Una columna nueva
--    escrita en ese UPDATE lanza restrict_violation, sale al front como el
--    generico 'Error al firmar la autorizacion', y esa persona no puede
--    autorizar NUNCA (sin autorizacion vigente su expediente queda muerto).
--    Los tres bloques del §8 ademas necesitan escribirse ANTES de firmar, que
--    es justo lo que esa tabla prohibe. Por eso viven aqui.
--
-- 2) NO agrega valores a `estado_expediente` ni a `estado_estudio` para el
--    "el prospecto reporta que no es el" del §12. No hace falta: reportar
--    marca la autorizacion como 'expirado' (la unica transicion que el trigger
--    permite sobre una fila pendiente, ya usada en produccion en
--    getAutorizacionByToken y enviarEnlaceAutorizacion), y a partir de ahi el
--    gate fail-closed assertAutorizacionVigente impide cualquier consulta
--    FACTURABLE al buro. Ampliar el enum romperia ESTADOS_ESTUDIO_FINALES,
--    ESTADOS_PERMITIDOS_EJECUCION, el guard de certificado y
--    fn_registrar_resultado_estudio — el mismo razonamiento del encabezado de
--    20260903000006. "Se marca para revision" = evento en eventos_timeline
--    (tipo 'estudio', que la UI ya lee) + banner + notificaciones.
--
-- 3) NO lleva trigger de inmutabilidad. Esto NO es evidencia legal del 8.4 —
--    la evidencia sigue viviendo entera en autorizaciones_habeas_data y sus
--    triggers, intactos. Congelar aqui solo lograria dos cosas malas: impedir
--    que el propio prospecto corrija una errata, y dejar la PII de un tercero
--    (`coarrendatario_intencion`, de alguien que todavia no consintio nada)
--    sin ninguna via tecnica de supresion. La defensa real es el chequeo de
--    estado='pendiente' que el servicio hace en cada escritura publica.
--
-- 4) NO toca `estudios_scorecard_sombra`. Ver el COMMENT de
--    ingreso_declarado_cop: ese es el punto entero de esta tabla.
--
-- ORDEN DE DESPLIEGUE: correr esta migracion ANTES de desplegar la API. El
-- codigo escribe aqui de forma best-effort (los fallos se loguean y no rompen
-- la firma), asi que un despliegue adelantado no bloquea a nadie: solo se
-- pierde lo que el prospecto declare hasta que la tabla exista.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.autorizacion_perfil_prospecto (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 1:1 con el EXPEDIENTE (no con la autorizacion): a un mismo expediente se
  -- le pueden reenviar varios enlaces, y lo que el prospecto ya conto no se
  -- pierde ni se duplica al reenviar. Es tambien la clave del upsert.
  expediente_id                 UUID NOT NULL UNIQUE
                                  REFERENCES public.expedientes(id) ON DELETE CASCADE,

  -- Enlace por el que llego lo declarado. SET NULL: la fila padre firmada no
  -- se puede borrar (fn_..._no_delete), pero si la autorizacion se reemplaza
  -- el perfil sigue siendo del expediente.
  autorizacion_id               UUID REFERENCES public.autorizaciones_habeas_data(id) ON DELETE SET NULL,

  -- ── §8.1 Confirmacion de identidad ────────────────────────────────────
  -- El prospecto CONFIRMA o REPORTA; nunca edita.
  -- `solicitantes.numero_documento` es el system-of-record: firmarAutorizacion
  -- lo congela como `numero_documento_aceptante` y autorizacion.guard.ts lo
  -- compara normalizado contra lo que se manda al buro. Si el portador anonimo
  -- del enlace pudiera reescribirlo, ese guard dejaria de ser un control y
  -- pasaria a ser una tautologia que el atacante controla ("el documento que
  -- acabo de teclear coincide con el documento que acabo de teclear"), y
  -- Cofianza consultaria al buro — consulta facturable e ilegal — sobre un
  -- titular de datos que jamas autorizo, con la evidencia del 8.4
  -- certificandolo limpiamente.
  identidad_confirmada          BOOLEAN NOT NULL DEFAULT false,
  identidad_confirmada_en       TIMESTAMPTZ,
  identidad_reporte             TEXT
                                  CHECK (identidad_reporte IS NULL
                                         OR identidad_reporte IN ('no_soy_yo','datos_incorrectos')),
  identidad_reporte_detalle     TEXT
                                  CHECK (identidad_reporte_detalle IS NULL
                                         OR char_length(identidad_reporte_detalle) <= 500),
  identidad_reporte_en          TIMESTAMPTZ,
  identidad_reporte_ip          VARCHAR(45),
  identidad_reporte_user_agent  TEXT,

  -- ── §8.2 Informacion laboral e ingresos — INTERNO DE COFIANZA ─────────
  -- Ninguna ruta del rol inmobiliaria ni del rol propietario devuelve estas
  -- tres columnas (allowlist por rol en getAutorizacionForExpediente). Esa es
  -- la garantia server-side de la promesa que el §8.2 hace en pantalla.
  situacion_laboral             TEXT
                                  CHECK (situacion_laboral IS NULL
                                         OR situacion_laboral IN ('empleado','independiente','pensionado','otro')),
  donde_labora                  VARCHAR(200),
  ingreso_declarado_cop         NUMERIC(14,2)
                                  CHECK (ingreso_declarado_cop IS NULL OR ingreso_declarado_cop >= 0),

  -- ── §8.3 Solo o acompanado — INTENCION, no invitacion ─────────────────
  presentacion                  TEXT
                                  CHECK (presentacion IS NULL
                                         OR presentacion IN ('solo','acompanado')),
  coarrendatario_intencion      JSONB,

  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_autorizacion_perfil_prospecto_autorizacion
  ON public.autorizacion_perfil_prospecto(autorizacion_id);

DROP TRIGGER IF EXISTS autorizacion_perfil_prospecto_updated_at
  ON public.autorizacion_perfil_prospecto;
CREATE TRIGGER autorizacion_perfil_prospecto_updated_at
  BEFORE UPDATE ON public.autorizacion_perfil_prospecto
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE public.autorizacion_perfil_prospecto ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.autorizacion_perfil_prospecto IS
  'Flujo §8 (PASO 5): lo que el prospecto declara en la pantalla publica de autorizacion — confirmacion de identidad (§8.1), situacion laboral e ingreso autorreportado (§8.2, interno de Cofianza) e intencion de presentarse solo o acompanado (§8.3). NO es evidencia legal del 8.4: esa vive en autorizaciones_habeas_data.';

COMMENT ON COLUMN public.autorizacion_perfil_prospecto.ingreso_declarado_cop IS
  'Ingreso AUTORREPORTADO por el prospecto (Flujo §8.2). Politica de Evaluacion y Score V4.1 §4.2, literal: "El ingreso mensual es INFERIDO AUTOMATICAMENTE POR EL SISTEMA a partir de las fuentes disponibles [...] Si el solicitante considera que el ingreso inferido es inferior al real, puede aportar documentacion EN EL PROCESO DE REVISION MANUAL." O sea: este numero NO es el ingreso del modelo y NO lo sustituye. PROHIBIDO copiarlo a estudios_scorecard_sombra.ingreso_inferido_cop (dti_pct y canon_ingreso_pct son GENERATED ALWAYS ... STORED: Postgres fabricaria los dos ratios del §4.2 y §4.3 sin que ningun control de aplicacion lo atrape), a features.ingreso_mensual_inferido_cop, o a cualquier entrada del motor. No confundir con el ingreso_evaluado_cop que reasignacion.service.ts declara como deuda: ese es el INFERIDO. Usos permitidos: mostrarselo al gestor interno etiquetado como autorreportado, y contrastarlo con el inferido como SENAL de discrepancia (calculada al vuelo en el endpoint de lectura, jamas persistida).';

COMMENT ON COLUMN public.autorizacion_perfil_prospecto.coarrendatario_intencion IS
  'INTENCION declarada, no invitacion: {nombre, apellido, email?, telefono?}. La invitacion real la emite el gestor con el modulo de co-arrendatarios cuando el expediente llega a condicionado (invitarCoarrendatario exige ese estado, y su ponderacion asume secuencialidad: onCoarrendatarioEstudioCompletado busca el estudio del titular en estado completado y, si no lo encuentra, retorna con un warn sin reintento — con los dos estudios en paralelo la ponderacion no ocurriria nunca).';
