-- ============================================================
-- Migración: Fechas bloqueadas + tope de visitas por día
-- Fecha: 2026-06-18
-- Descripción:
--   Dos controles nuevos para la agenda de visitas del propietario:
--     1. disponibilidad_fechas_bloqueadas — fechas puntuales (feriados,
--        vacaciones) en las que NO se ofrecen slots, aunque el día de la
--        semana esté habilitado.
--     2. configuracion_disponibilidad.max_citas_por_dia — tope de citas
--        (solicitada+confirmada) por día civil Bogotá para el propietario.
--        0 = sin límite (comportamiento previo).
--
--   Se reescriben fn_slots_disponibles (basada en 20260417000006) y
--   fn_slot_esta_disponible (basada en 20260417000004) para aplicar ambas
--   reglas tanto en el grid que ve el solicitante como en la verificación
--   anti-race del POST /citas. Toda la lógica previa (defaults L-V 9-17,
--   antelación, exclusión de citas ocupadas, offset Bogotá) se conserva.
-- ============================================================

-- ============================================================
-- 1. Columna: tope de citas por día
-- ============================================================

ALTER TABLE configuracion_disponibilidad
  ADD COLUMN IF NOT EXISTS max_citas_por_dia SMALLINT NOT NULL DEFAULT 0
    CHECK (max_citas_por_dia >= 0 AND max_citas_por_dia <= 50);

COMMENT ON COLUMN configuracion_disponibilidad.max_citas_por_dia IS
  'Tope de citas (solicitada+confirmada) por día civil Bogotá del propietario. 0 = sin límite.';

-- ============================================================
-- 2. Tabla: fechas bloqueadas
-- ============================================================

CREATE TABLE IF NOT EXISTS disponibilidad_fechas_bloqueadas (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  propietario_id UUID NOT NULL REFERENCES perfiles(id) ON DELETE CASCADE,
  fecha          DATE NOT NULL,
  motivo         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_fecha_bloqueada UNIQUE (propietario_id, fecha)
);

COMMENT ON TABLE disponibilidad_fechas_bloqueadas IS
  'Fechas puntuales en que el propietario no recibe visitas (feriados, vacaciones). El día completo queda sin slots.';

CREATE INDEX IF NOT EXISTS idx_fechas_bloqueadas_propietario
  ON disponibilidad_fechas_bloqueadas(propietario_id, fecha);

ALTER TABLE disponibilidad_fechas_bloqueadas ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 3. RPC: fn_slots_disponibles (reescritura sobre 20260417000006)
--    + exclusión de fechas bloqueadas
--    + tope de citas por día
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
     WHERE i.propietario_id = p_propietario_id
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
$$;

-- ============================================================
-- 4. RPC: fn_slot_esta_disponible (reescritura sobre 20260417000004)
--    + rechazo si la fecha está bloqueada
--    + rechazo si el día alcanzó el tope de citas
-- ============================================================

CREATE OR REPLACE FUNCTION fn_slot_esta_disponible(
  p_propietario_id UUID,
  p_inicio         TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
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
     WHERE i.propietario_id = p_propietario_id
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
     WHERE i.propietario_id = p_propietario_id
       AND c.estado IN ('solicitada', 'confirmada')
       AND COALESCE(c.fecha_confirmada, c.fecha_propuesta) IS NOT NULL
       AND (COALESCE(c.fecha_confirmada, c.fecha_propuesta) AT TIME ZONE 'America/Bogota')::DATE = v_fecha_civil;

    IF v_conteo_dia >= v_max_citas THEN
      RETURN FALSE;
    END IF;
  END IF;

  RETURN TRUE;
END;
$$;
