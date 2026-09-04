-- ============================================================
-- Portabilidad del estudio a otra propiedad (Flujo §4.3) — traza auditable.
--
-- Flujo de Gerencia, modulo de estudios, §4.3 (CAMBIO APROBADO, literal):
--   "Un estudio ya pagado y ejecutado puede reutilizarse para una propiedad
--    distinta sin costo adicional, siempre que el canon de la nueva propiedad
--    este dentro de la tolerancia establecida en la Politica de Evaluacion
--    (hasta +15%, con recalculo de la relacion canon/ingreso menor o igual al
--    40%). [...] El estudio conserva su vigencia original; la reutilizacion no
--    la extiende."
--
-- ── QUE HACE ESTA MIGRACION Y QUE NO ─────────────────────────────────────
--
-- HACE: una sola tabla de traza. Nada mas.
--
-- NO agrega el estado 'reasignado' del §11 al enum `estado_estudio`, y no es
-- un olvido. En este diseño el estudio NO se mueve ni cambia de estado: lo que
-- se mueve es `expedientes.inmueble_id`. El estudio sigue 'completado', que es
-- la verdad — el resultado del buro no cambio porque el inmueble si.
--
-- Agregar el valor romperia, en cascada:
--   * ESTADOS_ESTUDIO_FINALES (estudios-simultaneos.guard.ts) y con el el
--     contador de "estudios en curso" del §4.2, que pasaria a contar como
--     activo un estudio ya terminado;
--   * ESTADOS_PERMITIDOS_EJECUCION (estudios.service.ts) -> se perderia el
--     reintento y la re-consulta al otro buro;
--   * el guard `estado <> 'completado'` de certificado.service.ts -> el estudio
--     portado dejaria de poder certificarse, que es JUSTO lo que el prospecto
--     necesita en la propiedad nueva;
--   * fn_registrar_resultado_estudio (IF v_estado NOT IN ('solicitado','en_proceso')).
--
-- La lista del §11 es de estados que ve el PROSPECTO, no del enum: incluye
-- tambien "Borrador", "Esperando autorizacion" y "Expirado", que tampoco son
-- valores de `estado_estudio`. "Reasignado" se resuelve como etiqueta derivada:
-- hay reasignacion si existe una fila en esta tabla.
--
-- ── POR QUE UNA TABLA Y NO UNAS COLUMNAS EN `estudios` ───────────────────
--
-- Porque un estudio puede reasignarse MAS DE UNA VEZ (el prospecto sigue
-- buscando vivienda: ese es el beneficio comercial del §4.3), y unas columnas
-- solo guardarian la ultima. Con una fila por traslado, "de que propiedad a
-- cual, con que canones, con que veredicto y quien lo autorizo" queda completo.
--
-- Es tambien lo que hace VERIFICABLES las dos promesas del documento que, sin
-- registro, serian solo declaraciones: `se_cobro = false` (no se cobro dos
-- veces) y `vigencia_hasta_conservada` (no se extendio la vigencia).
--
-- ORDEN DE DESPLIEGUE: el codigo no depende de esta tabla para funcionar. Si
-- se despliega antes de correr la migracion, la reasignacion se hace igual y
-- queda trazada en `eventos_timeline` y en `bitacora`; el INSERT de aqui falla
-- y se registra un error que nombra esta migracion. Se eligio asi a proposito:
-- una traza incompleta es un problema de auditoria, pero bloquear el §4.3 por
-- una tabla ausente le costaria al prospecto una evaluacion que ya pago.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.estudios_reasignaciones (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- El estudio que se reutiliza. CASCADE: si el estudio se borra, su historia
  -- de traslados no tiene a quien pertenecer.
  estudio_id                  UUID NOT NULL
                                REFERENCES public.estudios(id) ON DELETE CASCADE,
  -- El expediente que efectivamente se movio. Es el mismo antes y despues: lo
  -- que cambia es su inmueble_id (ver reasignacion.service.ts para por que no
  -- se mueve el estudio de expediente ni se crea uno nuevo).
  expediente_id               UUID NOT NULL
                                REFERENCES public.expedientes(id) ON DELETE CASCADE,

  -- ── El traslado ──────────────────────────────────────────
  -- NO ACTION en los inmuebles: borrar una propiedad no puede borrar la
  -- evidencia de que un estudio se reutilizo sobre ella.
  inmueble_origen_id          UUID NOT NULL REFERENCES public.inmuebles(id),
  inmueble_destino_id         UUID NOT NULL REFERENCES public.inmuebles(id),
  CONSTRAINT chk_reasignacion_inmuebles_distintos
    CHECK (inmueble_origen_id <> inmueble_destino_id),

  -- ── La condicion 1: tolerancia ───────────────────────────
  -- `canon_origen_cop` es el canon CONGELADO del estudio
  -- (estudios.canon_evaluado), no el canon actual del inmueble origen — que es
  -- editable y pudo cambiar. Si el estudio no lo tiene, no es portable y no
  -- llega a haber fila aqui.
  canon_origen_cop            NUMERIC(12,2) NOT NULL CHECK (canon_origen_cop > 0),
  canon_destino_cop           NUMERIC(12,2) NOT NULL CHECK (canon_destino_cop > 0),
  -- El techo que se aplico: canon_origen * (100 + tolerancia) / 100. Se guarda
  -- calculado y no se rederiva, para que la fila siga explicando la decision
  -- aunque la tolerancia cambie despues.
  canon_maximo_tolerado_cop   NUMERIC(12,2) NOT NULL CHECK (canon_maximo_tolerado_cop > 0),
  tolerancia_pct              NUMERIC(5,2)  NOT NULL CHECK (tolerancia_pct >= 0),

  -- ── La condicion 2: recalculo canon/ingreso <= 40% ───────
  -- NULL cuando no se pudo evaluar. NULL != 0 y NULL != incumplida: el buro
  -- puede no haber entregado ingreso inferido (TransUnion nunca lo hace), y la
  -- doctrina del repo es "no calculable != incumplida" (reglas-duras.ts,
  -- Politica §2 y §6). Por eso el veredicto se guarda EXPLICITO al lado del
  -- numero: sin el, un NULL no distinguiria "no se miro" de "no se pudo".
  canon_ingreso_destino_pct   NUMERIC(12,2)
                                CHECK (canon_ingreso_destino_pct IS NULL OR canon_ingreso_destino_pct >= 0),
  veredicto_canon_ingreso     VARCHAR(20) NOT NULL
                                CHECK (veredicto_canon_ingreso IN ('cumple', 'no_cumple', 'no_evaluable')),

  -- ── Las dos promesas del §4.3, hechas verificables ───────
  -- "El estudio conserva su vigencia original; la reutilizacion no la extiende":
  -- se ancla en estudios.fecha_completado + la ventana de vigencia vigente, NO
  -- en la emision del certificado (si se anclara ahi, regenerar el certificado
  -- despues de reasignar regalaria una vigencia nueva). NULL solo si el estudio
  -- no tiene fecha_completado.
  vigencia_hasta_conservada   TIMESTAMPTZ,
  -- "Sin costo adicional". Es una columna y no una constante del codigo para
  -- que un auditor pueda comprobarlo con un SELECT en vez de leyendo el
  -- servicio. Si algun dia una reasignacion cobrara, esta fila lo diria.
  se_cobro                    BOOLEAN NOT NULL DEFAULT FALSE,

  -- ── El certificado, si lo habia ──────────────────────────
  -- El PDF del certificado es INMUTABLE y lleva impresos la direccion, el
  -- codigo y el canon del inmueble; /verificar/<codigo>, en cambio, deriva la
  -- propiedad de expedientes.inmueble_id en tiempo de lectura. Sin regenerarlo,
  -- un mismo codigo describia dos propiedades distintas segun por donde se lo
  -- mirara. La reasignacion lo regenera (mismo codigo, version+1 y —al estar la
  -- vigencia anclada en fecha_completado— el mismo vencimiento), y aqui queda
  -- constancia de que paso:
  --   'sin_certificado' -> no habia ninguno emitido.
  --   'regenerado'      -> se reimprimio con la propiedad nueva.
  --   'desactualizado'  -> la regeneracion fallo; el certificado sigue
  --                        nombrando la propiedad anterior y hay que
  --                        regenerarlo a mano antes de entregarlo.
  certificado_estado          VARCHAR(20) NOT NULL DEFAULT 'sin_certificado'
                                CHECK (certificado_estado IN (
                                  'sin_certificado', 'regenerado', 'desactualizado'
                                )),

  -- ── Quien y cuando ───────────────────────────────────────
  -- La reasignacion la autoriza un gestor (expedientes:update). SET NULL: si
  -- el perfil se borra, la traza sobrevive sin autor antes que desaparecer.
  reasignado_por              UUID REFERENCES public.perfiles(id) ON DELETE SET NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Las dos preguntas que se le hacen a esta tabla: "¿este estudio se reasigno?"
-- (la etiqueta derivada del §11) y "¿que paso con este expediente?" (el
-- historial que el timeline cuenta en prosa).
CREATE INDEX IF NOT EXISTS idx_estudios_reasignaciones_estudio
  ON public.estudios_reasignaciones (estudio_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_estudios_reasignaciones_expediente
  ON public.estudios_reasignaciones (expediente_id, created_at DESC);

COMMENT ON TABLE public.estudios_reasignaciones IS
  'Traza de la portabilidad del Flujo §4.3: cada vez que un estudio ya pagado y ejecutado se reutiliza para otra propiedad sin costo. Una fila por traslado (un estudio puede reasignarse varias veces). NO existe un estado ''reasignado'' en estudios: el estudio sigue ''completado'' y lo que se movio fue expedientes.inmueble_id.';

COMMENT ON COLUMN public.estudios_reasignaciones.canon_origen_cop IS
  'Canon CONGELADO con el que se ejecuto el estudio (estudios.canon_evaluado), no el canon actual del inmueble origen — que es editable y pudo cambiar despues.';

COMMENT ON COLUMN public.estudios_reasignaciones.veredicto_canon_ingreso IS
  'Resultado de la segunda condicion del §4.3. ''no_evaluable'' cuando el buro no entrego ingreso inferido: NO bloquea la reasignacion (no calculable != incumplida, Politica §2/§6), pero queda registrado para que la decision sea auditable.';

COMMENT ON COLUMN public.estudios_reasignaciones.certificado_estado IS
  'Que paso con el certificado ya emitido al trasladar el expediente. ''desactualizado'' senala las filas donde el PDF quedo describiendo la propiedad anterior: son las que hay que revisar, porque el mismo codigo de certificado dice una propiedad en el PDF y otra en /verificar.';

COMMENT ON COLUMN public.estudios_reasignaciones.se_cobro IS
  'Siempre FALSE hoy: el §4.3 promete "sin costo adicional". Es columna y no constante para que la promesa se pueda auditar con un SELECT.';
