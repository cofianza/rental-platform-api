-- ============================================================
-- 20261001000007 — decisiones del 2026-09-24 (paquete Q7).
-- Idempotente; el API funciona antes y después de correrla.
--
-- 1) Moras — horario de cobranza (Ley 2300 de 2023, art. 3).
--    Los WhatsApp de cobro solo salen de lunes a viernes de 7 a. m. a 7 p. m.
--    y los sábados de 8 a. m. a 3 p. m. (sin domingos ni festivos), y una sola
--    gestión por día al mismo deudor. Lo que cae fuera queda programado en
--    whatsapp_programado_para y lo manda su propio barrido
--    (MORAS_COBROS_PROGRAMADOS_ENABLED, cada 15 min). La gestión del día se
--    toma ANTES de enviar en moras_gestiones_diarias: la llave única
--    (teléfono normalizado, día en Colombia) impide dos el mismo día aunque
--    el barrido y un escalado a mano corran a la vez. Sin estas piezas el API
--    envía en el acto, como antes.
--    P27: whatsapp_pausado_at = el dueño reportó un pago en Fase 3 y el
--    WhatsApp pendiente espera la revisión de Cofianza.
-- ============================================================

ALTER TABLE moras_tickets ADD COLUMN IF NOT EXISTS whatsapp_programado_para TIMESTAMPTZ;
ALTER TABLE moras_tickets ADD COLUMN IF NOT EXISTS whatsapp_pausado_at TIMESTAMPTZ;

COMMENT ON COLUMN moras_tickets.whatsapp_programado_para IS
  'Cuándo sale el WhatsApp de cobro de la fase actual que la Ley 2300 dejó esperando (fuera de horario o con otra gestión ese día). NULL = nada pendiente.';
COMMENT ON COLUMN moras_tickets.whatsapp_pausado_at IS
  'El dueño reportó un pago en Fase 3: el WhatsApp pendiente no sale hasta que Cofianza lo reanude. NULL = sin pausa.';

CREATE TABLE IF NOT EXISTS public.moras_gestiones_diarias (
  telefono   TEXT NOT NULL,                -- solo dígitos, con indicativo (57…)
  dia        DATE NOT NULL,                -- día civil en Colombia
  mora_id    UUID REFERENCES moras_tickets(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (telefono, dia)
);

COMMENT ON TABLE public.moras_gestiones_diarias IS
  'Ley 2300 de 2023: una gestión de cobranza por día al mismo deudor. El API inserta antes de enviar; el choque de llave (23505) significa que ya hubo una ese día.';

ALTER TABLE public.moras_gestiones_diarias ENABLE ROW LEVEL SECURITY;  -- teléfonos; sin policies = solo service_role
REVOKE ALL ON TABLE public.moras_gestiones_diarias FROM PUBLIC, anon, authenticated;

-- ============================================================
-- 2) Agenda de visitas por inmobiliaria (P37).
--    Una sola agenda por organización: la del titular principal
--    (inmobiliarias.owner_perfil_id), que el API ya pasa como p_propietario_id
--    para todos los inmuebles de la organización. Aquí cambia solo la
--    OCUPACIÓN: cuentan las visitas solicitadas/confirmadas de todos los
--    inmuebles de la organización de ese titular, no solo los que él registró;
--    sin esto se pierde la protección contra reservas dobles.
--    Cuerpos copiados de lo desplegado (pg_get_functiondef, 2026-09-24): el
--    único cambio es el WHERE de las visitas que ocupan (3 lugares). Misma
--    firma: CREATE OR REPLACE conserva dueño y permisos.
--    Compatible con el API anterior: con el id de un asesor la condición sigue
--    contando sus propios inmuebles, como antes.
-- ============================================================

CREATE OR REPLACE FUNCTION public.fn_slots_disponibles(p_propietario_id uuid, p_fecha_desde date, p_fecha_hasta date)
 RETURNS json
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  v_duracion_min       SMALLINT;
  v_antelacion_horas   SMALLINT;
  v_max_citas          SMALLINT;
  v_corte_antelacion   TIMESTAMPTZ;
  v_has_filas          BOOLEAN;
  v_result             JSON;
BEGIN
  -- Validaciones de rango
  IF p_fecha_hasta < p_fecha_desde THEN
    RAISE EXCEPTION 'fecha_hasta debe ser >= fecha_desde';
  END IF;

  IF (p_fecha_hasta - p_fecha_desde) > 30 THEN
    RAISE EXCEPTION 'Ventana máxima 30 días';
  END IF;

  -- Cargar config del propietario (fallback a valores por defecto)
  SELECT
    COALESCE(c.slot_duracion_minutos, 60),
    COALESCE(c.antelacion_minima_horas, 24),
    COALESCE(c.max_citas_por_dia, 0)
    INTO v_duracion_min, v_antelacion_horas, v_max_citas
    FROM (SELECT 1) _
    LEFT JOIN configuracion_disponibilidad c ON c.propietario_id = p_propietario_id;

  -- ¿Tiene el propietario filas explícitas en disponibilidad_propietario?
  SELECT EXISTS (
    SELECT 1 FROM disponibilidad_propietario
    WHERE propietario_id = p_propietario_id
  ) INTO v_has_filas;

  IF NOT v_has_filas THEN
    RAISE WARNING 'Propietario % sin config de disponibilidad — aplicando defaults L-V 9-17', p_propietario_id;
  END IF;

  -- Corte por antelación mínima (en hora Bogotá).
  v_corte_antelacion := NOW() + (v_antelacion_horas || ' hours')::INTERVAL;

  -- Cálculo del grid con CTEs.
  WITH
  disp AS (
    SELECT dia_semana, hora_inicio, hora_fin
      FROM disponibilidad_propietario
      WHERE propietario_id = p_propietario_id AND activo = TRUE
    UNION ALL
    SELECT d::SMALLINT, TIME '09:00', TIME '17:00'
      FROM generate_series(1, 5) d
      WHERE NOT v_has_filas
  ),
  fechas AS (
    SELECT d::DATE AS fecha
      FROM generate_series(p_fecha_desde, p_fecha_hasta, INTERVAL '1 day') d
  ),
  -- Fechas bloqueadas del propietario dentro del rango.
  bloqueadas AS (
    SELECT fecha
      FROM disponibilidad_fechas_bloqueadas
     WHERE propietario_id = p_propietario_id
       AND fecha BETWEEN p_fecha_desde AND p_fecha_hasta
  ),
  candidatos AS (
    SELECT
      f.fecha,
      (
        ((f.fecha + d.hora_inicio)::TIMESTAMP + (n * v_duracion_min || ' minutes')::INTERVAL)
        AT TIME ZONE 'America/Bogota'
      ) AS slot_inicio,
      (
        ((f.fecha + d.hora_inicio)::TIMESTAMP + ((n + 1) * v_duracion_min || ' minutes')::INTERVAL)
        AT TIME ZONE 'America/Bogota'
      ) AS slot_fin
    FROM fechas f
    JOIN disp d ON EXTRACT(DOW FROM f.fecha)::SMALLINT = d.dia_semana
    CROSS JOIN LATERAL (
      SELECT generate_series(
        0,
        GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (d.hora_fin - d.hora_inicio)) / 60 / v_duracion_min)::INT - 1)
      ) AS n
    ) _
  ),
  ocupadas AS (
    SELECT COALESCE(c.fecha_confirmada, c.fecha_propuesta) AS ts
      FROM citas c
      JOIN expedientes e ON e.id = c.expediente_id
      JOIN inmuebles   i ON i.id = e.inmueble_id
     WHERE (i.propietario_id = p_propietario_id
            OR i.inmobiliaria_id IN (SELECT o.id FROM inmobiliarias o WHERE o.owner_perfil_id = p_propietario_id))
       AND c.estado IN ('solicitada', 'confirmada')
       AND COALESCE(c.fecha_confirmada, c.fecha_propuesta) IS NOT NULL
       AND COALESCE(c.fecha_confirmada, c.fecha_propuesta) >= (p_fecha_desde::TIMESTAMP AT TIME ZONE 'America/Bogota') - INTERVAL '1 day'
       AND COALESCE(c.fecha_confirmada, c.fecha_propuesta) <= ((p_fecha_hasta + 1)::TIMESTAMP AT TIME ZONE 'America/Bogota')
  ),
  -- Conteo de citas por día civil Bogotá (para el tope max_citas_por_dia).
  conteo_dia AS (
    SELECT (o.ts AT TIME ZONE 'America/Bogota')::DATE AS fecha, COUNT(*) AS n
      FROM ocupadas o
     GROUP BY 1
  ),
  disponibles AS (
    SELECT c.fecha, c.slot_inicio, c.slot_fin
      FROM candidatos c
     WHERE c.slot_inicio >= v_corte_antelacion
       -- No solaparse con citas ocupadas.
       AND NOT EXISTS (
         SELECT 1 FROM ocupadas o
          WHERE o.ts < c.slot_fin
            AND o.ts + (v_duracion_min || ' minutes')::INTERVAL > c.slot_inicio
       )
       -- No estar en una fecha bloqueada.
       AND NOT EXISTS (
         SELECT 1 FROM bloqueadas b WHERE b.fecha = c.fecha
       )
       -- No exceder el tope de citas del día (0 = sin límite).
       AND (
         v_max_citas = 0
         OR COALESCE((SELECT cd.n FROM conteo_dia cd WHERE cd.fecha = c.fecha), 0) < v_max_citas
       )
  )
  SELECT json_agg(x ORDER BY x.fecha) INTO v_result
    FROM (
      SELECT
        f.fecha::TEXT AS fecha,
        COALESCE(
          (SELECT json_agg(
              json_build_object(
                'inicio', to_char(d.slot_inicio AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD"T"HH24:MI:SS') || '-05:00',
                'fin',    to_char(d.slot_fin    AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD"T"HH24:MI:SS') || '-05:00'
              )
              ORDER BY d.slot_inicio
            )
            FROM disponibles d WHERE d.fecha = f.fecha),
          '[]'::JSON
        ) AS slots
      FROM (SELECT fecha FROM fechas) f
    ) x;

  RETURN COALESCE(v_result, '[]'::JSON);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_slot_esta_disponible(p_propietario_id uuid, p_inicio timestamp with time zone)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  v_duracion_min       SMALLINT;
  v_antelacion_horas   SMALLINT;
  v_max_citas          SMALLINT;
  v_corte_antelacion   TIMESTAMPTZ;
  v_fin                TIMESTAMPTZ;
  v_inicio_bogota      TIMESTAMP;
  v_fecha_civil        DATE;
  v_dia_semana         SMALLINT;
  v_hora_inicio        TIME;
  v_hora_fin           TIME;
  v_has_filas          BOOLEAN;
  v_tiene_ventana      BOOLEAN;
  v_esta_ocupado       BOOLEAN;
  v_conteo_dia         INT;
BEGIN
  -- Config
  SELECT
    COALESCE(c.slot_duracion_minutos, 60),
    COALESCE(c.antelacion_minima_horas, 24),
    COALESCE(c.max_citas_por_dia, 0)
    INTO v_duracion_min, v_antelacion_horas, v_max_citas
    FROM (SELECT 1) _
    LEFT JOIN configuracion_disponibilidad c ON c.propietario_id = p_propietario_id;

  v_fin := p_inicio + (v_duracion_min || ' minutes')::INTERVAL;
  v_corte_antelacion := NOW() + (v_antelacion_horas || ' hours')::INTERVAL;

  -- 1. Antelación mínima
  IF p_inicio < v_corte_antelacion THEN
    RETURN FALSE;
  END IF;

  -- 2. Caer dentro de alguna ventana de disponibilidad
  v_inicio_bogota := p_inicio AT TIME ZONE 'America/Bogota';
  v_fecha_civil   := v_inicio_bogota::DATE;
  v_dia_semana    := EXTRACT(DOW FROM v_inicio_bogota)::SMALLINT;
  v_hora_inicio   := v_inicio_bogota::TIME;
  v_hora_fin      := (v_fin AT TIME ZONE 'America/Bogota')::TIME;

  IF v_hora_fin <= v_hora_inicio THEN
    RETURN FALSE;
  END IF;

  -- 2.5. Fecha bloqueada (feriado/vacaciones) → no disponible.
  IF EXISTS (
    SELECT 1 FROM disponibilidad_fechas_bloqueadas
     WHERE propietario_id = p_propietario_id
       AND fecha = v_fecha_civil
  ) THEN
    RETURN FALSE;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM disponibilidad_propietario
     WHERE propietario_id = p_propietario_id
  ) INTO v_has_filas;

  IF v_has_filas THEN
    SELECT EXISTS (
      SELECT 1 FROM disponibilidad_propietario
       WHERE propietario_id = p_propietario_id
         AND activo = TRUE
         AND dia_semana = v_dia_semana
         AND hora_inicio <= v_hora_inicio
         AND hora_fin >= v_hora_fin
    ) INTO v_tiene_ventana;
  ELSE
    v_tiene_ventana :=
      v_dia_semana BETWEEN 1 AND 5
      AND v_hora_inicio >= TIME '09:00'
      AND v_hora_fin <= TIME '17:00';
  END IF;

  IF NOT v_tiene_ventana THEN
    RETURN FALSE;
  END IF;

  -- 3. No estar ocupado por cita solicitada|confirmada del propietario.
  SELECT EXISTS (
    SELECT 1 FROM citas c
      JOIN expedientes e ON e.id = c.expediente_id
      JOIN inmuebles   i ON i.id = e.inmueble_id
     WHERE (i.propietario_id = p_propietario_id
            OR i.inmobiliaria_id IN (SELECT o.id FROM inmobiliarias o WHERE o.owner_perfil_id = p_propietario_id))
       AND c.estado IN ('solicitada', 'confirmada')
       AND COALESCE(c.fecha_confirmada, c.fecha_propuesta) IS NOT NULL
       AND COALESCE(c.fecha_confirmada, c.fecha_propuesta) < v_fin
       AND COALESCE(c.fecha_confirmada, c.fecha_propuesta)
           + (v_duracion_min || ' minutes')::INTERVAL > p_inicio
  ) INTO v_esta_ocupado;

  IF v_esta_ocupado THEN
    RETURN FALSE;
  END IF;

  -- 4. Tope de citas por día (0 = sin límite). Cuenta las citas existentes
  --    de ese día civil; si ya alcanzó el tope, el día está lleno.
  IF v_max_citas > 0 THEN
    SELECT COUNT(*) INTO v_conteo_dia
      FROM citas c
      JOIN expedientes e ON e.id = c.expediente_id
      JOIN inmuebles   i ON i.id = e.inmueble_id
     WHERE (i.propietario_id = p_propietario_id
            OR i.inmobiliaria_id IN (SELECT o.id FROM inmobiliarias o WHERE o.owner_perfil_id = p_propietario_id))
       AND c.estado IN ('solicitada', 'confirmada')
       AND COALESCE(c.fecha_confirmada, c.fecha_propuesta) IS NOT NULL
       AND (COALESCE(c.fecha_confirmada, c.fecha_propuesta) AT TIME ZONE 'America/Bogota')::DATE = v_fecha_civil;

    IF v_conteo_dia >= v_max_citas THEN
      RETURN FALSE;
    END IF;
  END IF;

  RETURN TRUE;
END;
$function$;
