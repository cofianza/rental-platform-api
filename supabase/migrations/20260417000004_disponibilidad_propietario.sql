-- ============================================================
-- Migración: Disponibilidad del propietario + RPC de slots
-- Fecha: 2026-04-17
-- Descripción:
--   Sustenta el calendario estilo Doctoralia para el solicitante.
--   Agrega:
--     - disponibilidad_propietario  (horarios recurrentes semanales)
--     - configuracion_disponibilidad (duración de slot y antelación)
--     - fn_slots_disponibles         (RPC: grid de slots libres en rango)
--     - fn_slot_esta_disponible      (RPC: verificación puntual, anti-race)
--
--   Convención de tiempos:
--     Timezone fijo 'America/Bogota' (UTC-5, sin DST).
--     dia_semana: 0=Domingo … 6=Sábado (Postgres EXTRACT(DOW)).
--
--   Estados que bloquean un slot: 'solicitada' y 'confirmada'.
--   'realizada' NO bloquea (el slot vuelve a estar libre una vez pasó).
--   'cancelada' y 'no_asistio' tampoco bloquean.
-- ============================================================

-- ============================================================
-- 1. TABLA: disponibilidad_propietario
-- ============================================================

CREATE TABLE IF NOT EXISTS disponibilidad_propietario (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  propietario_id UUID NOT NULL REFERENCES perfiles(id) ON DELETE CASCADE,
  dia_semana     SMALLINT NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
  hora_inicio    TIME NOT NULL,
  hora_fin       TIME NOT NULL,
  activo         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_disponibilidad_horario CHECK (hora_fin > hora_inicio),
  CONSTRAINT uq_disponibilidad_propietario_dia UNIQUE (propietario_id, dia_semana)
);

COMMENT ON COLUMN disponibilidad_propietario.dia_semana IS
  '0=Domingo, 1=Lunes, 2=Martes, 3=Miércoles, 4=Jueves, 5=Viernes, 6=Sábado (convención Postgres EXTRACT(DOW))';

COMMENT ON COLUMN disponibilidad_propietario.hora_inicio IS
  'Hora local Bogotá. Se interpreta AT TIME ZONE America/Bogota en el RPC.';

COMMENT ON COLUMN disponibilidad_propietario.hora_fin IS
  'Hora local Bogotá. Exclusiva — si hora_fin = 17:00, el último slot de 60min es 16:00-17:00.';

CREATE INDEX IF NOT EXISTS idx_disponibilidad_propietario
  ON disponibilidad_propietario(propietario_id)
  WHERE activo = TRUE;

CREATE TRIGGER trg_disponibilidad_propietario_updated_at
  BEFORE UPDATE ON disponibilidad_propietario
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE disponibilidad_propietario ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 2. TABLA: configuracion_disponibilidad
-- ============================================================

CREATE TABLE IF NOT EXISTS configuracion_disponibilidad (
  propietario_id          UUID PRIMARY KEY REFERENCES perfiles(id) ON DELETE CASCADE,
  slot_duracion_minutos   SMALLINT NOT NULL DEFAULT 60
    CHECK (slot_duracion_minutos IN (30, 60, 120)),
  antelacion_minima_horas SMALLINT NOT NULL DEFAULT 24
    CHECK (antelacion_minima_horas >= 0 AND antelacion_minima_horas <= 168),
  activa                  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE configuracion_disponibilidad IS
  'Configuración por propietario. Duración de slot y antelación mínima.';

CREATE TRIGGER trg_configuracion_disponibilidad_updated_at
  BEFORE UPDATE ON configuracion_disponibilidad
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE configuracion_disponibilidad ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 3. RPC: fn_slots_disponibles
--    Genera grid de slots libres para rango de fechas.
--    Defaults L-V 9-17 SOLO si el propietario no tiene fila alguna en
--    disponibilidad_propietario. Si tiene filas (aunque todas inactivas),
--    se respeta la decisión — no se inyectan defaults.
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

-- ============================================================
-- 4. RPC: fn_slot_esta_disponible
--    Verificación puntual — guard anti-race en POST /citas.
--    Recibe solo el inicio; deriva la duración del propietario.
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
  v_corte_antelacion   TIMESTAMPTZ;
  v_fin                TIMESTAMPTZ;
  v_inicio_bogota      TIMESTAMP;
  v_dia_semana         SMALLINT;
  v_hora_inicio        TIME;
  v_hora_fin           TIME;
  v_has_filas          BOOLEAN;
  v_tiene_ventana      BOOLEAN;
  v_esta_ocupado       BOOLEAN;
BEGIN
  -- Config
  SELECT
    COALESCE(c.slot_duracion_minutos, 60),
    COALESCE(c.antelacion_minima_horas, 24)
    INTO v_duracion_min, v_antelacion_horas
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
  v_dia_semana    := EXTRACT(DOW FROM v_inicio_bogota)::SMALLINT;
  v_hora_inicio   := v_inicio_bogota::TIME;
  v_hora_fin      := (v_fin AT TIME ZONE 'America/Bogota')::TIME;

  -- Si el slot cruza medianoche (muy raro con 30/60/120 min + ventanas
  -- típicas), v_hora_fin < v_hora_inicio → rechazar conservadoramente.
  IF v_hora_fin <= v_hora_inicio THEN
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
    -- Defaults L-V 9-17
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

  RETURN NOT v_esta_ocupado;
END;
$$;
