-- ============================================================
-- Migración: Fix timezone offset en fn_slots_disponibles
-- Fecha: 2026-04-18
-- Descripción:
--   Los timestamps del JSON de salida ahora emiten offset -05:00
--   explícito (Bogotá) en lugar de +00:00 (UTC). Los datos son los
--   mismos (14:00 UTC = 09:00 Bogotá), solo cambia la representación
--   para facilitar debugging y evitar errores de interpretación en
--   el frontend.
--
--   Cambio mínimo: se añade `SET LOCAL TIMEZONE = 'America/Bogota'`
--   al inicio del BEGIN. Toda la lógica interna (defaults L-V 9-17,
--   filtros de antelación, exclusión de citas ocupadas, etc.) queda
--   idéntica.
--
--   fn_slot_esta_disponible NO se modifica: retorna BOOLEAN, no
--   timestamps, no le aplica este problema.
-- ============================================================

CREATE OR REPLACE FUNCTION fn_slots_disponibles(
  p_propietario_id UUID,
  p_fecha_desde    DATE,
  p_fecha_hasta    DATE
)
RETURNS JSON
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_duracion_min       SMALLINT;
  v_antelacion_horas   SMALLINT;
  v_corte_antelacion   TIMESTAMPTZ;
  v_has_filas          BOOLEAN;
  v_result             JSON;
BEGIN
  -- SET LOCAL TIMEZONE solo afecta la serialización TIMESTAMPTZ → texto
  -- dentro de esta RPC. Las operaciones temporales internas (AT TIME ZONE,
  -- NOW(), EXTRACT) no se ven afectadas porque usan referencias explícitas
  -- a 'America/Bogota' donde corresponde. El efecto es contenido a la
  -- transacción del RPC — al terminar, la sesión vuelve a su zona previa.
  SET LOCAL TIMEZONE = 'America/Bogota';

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
    COALESCE(c.antelacion_minima_horas, 24)
    INTO v_duracion_min, v_antelacion_horas
    FROM (SELECT 1) _
    LEFT JOIN configuracion_disponibilidad c ON c.propietario_id = p_propietario_id;

  -- ¿Tiene el propietario filas explícitas en disponibilidad_propietario?
  -- Determina si aplicamos defaults L-V 9-17.
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
  -- Disponibilidad efectiva: filas reales del propietario (activo=true) o
  -- defaults L-V 9-17 si no hay ninguna fila en la tabla.
  disp AS (
    SELECT dia_semana, hora_inicio, hora_fin
      FROM disponibilidad_propietario
      WHERE propietario_id = p_propietario_id AND activo = TRUE
    UNION ALL
    SELECT d::SMALLINT, TIME '09:00', TIME '17:00'
      FROM generate_series(1, 5) d
      WHERE NOT v_has_filas
  ),
  -- Serie de fechas civiles en el rango.
  fechas AS (
    SELECT d::DATE AS fecha
      FROM generate_series(p_fecha_desde, p_fecha_hasta, INTERVAL '1 day') d
  ),
  -- Slots candidatos: para cada fecha × ventana × N slot-duracion.
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
  -- Citas del propietario que bloquean slots: solicitada | confirmada.
  -- realizada no bloquea (el slot vuelve a estar libre una vez pasó).
  ocupadas AS (
    SELECT COALESCE(c.fecha_confirmada, c.fecha_propuesta) AS ts
      FROM citas c
      JOIN expedientes e ON e.id = c.expediente_id
      JOIN inmuebles   i ON i.id = e.inmueble_id
     WHERE i.propietario_id = p_propietario_id
       AND c.estado IN ('solicitada', 'confirmada')
       AND COALESCE(c.fecha_confirmada, c.fecha_propuesta) IS NOT NULL
       -- Ventana amplia para capturar citas que se solapan con el rango.
       AND COALESCE(c.fecha_confirmada, c.fecha_propuesta) >= (p_fecha_desde::TIMESTAMP AT TIME ZONE 'America/Bogota') - INTERVAL '1 day'
       AND COALESCE(c.fecha_confirmada, c.fecha_propuesta) <= ((p_fecha_hasta + 1)::TIMESTAMP AT TIME ZONE 'America/Bogota')
  ),
  -- Filtro final: antelación + no-overlap con citas ocupadas.
  -- Overlap asume que cada cita dura v_duracion_min (config actual).
  disponibles AS (
    SELECT c.fecha, c.slot_inicio, c.slot_fin
      FROM candidatos c
     WHERE c.slot_inicio >= v_corte_antelacion
       AND NOT EXISTS (
         SELECT 1 FROM ocupadas o
          WHERE o.ts < c.slot_fin
            AND o.ts + (v_duracion_min || ' minutes')::INTERVAL > c.slot_inicio
       )
  )
  -- Agrupar por fecha; incluir fechas sin slots (array vacío) para que el
  -- frontend muestre "sin disponibilidad" en el calendario.
  SELECT json_agg(x ORDER BY x.fecha) INTO v_result
    FROM (
      SELECT
        f.fecha::TEXT AS fecha,
        COALESCE(
          (SELECT json_agg(
              json_build_object('inicio', d.slot_inicio, 'fin', d.slot_fin)
              ORDER BY d.slot_inicio
            )
            FROM disponibles d WHERE d.fecha = f.fecha),
          '[]'::JSON
        ) AS slots
      FROM (SELECT fecha FROM fechas) f
    ) x;

  RETURN COALESCE(v_result, '[]'::JSON);
END;
$$;
