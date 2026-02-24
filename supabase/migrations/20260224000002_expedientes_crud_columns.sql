-- ============================================================
-- Expedientes CRUD - Columnas adicionales + secuencia anual + RPC listado
-- Tarea: CRUD Expedientes Backend
-- ============================================================

-- 1. Agregar columna notas (observaciones internas)
ALTER TABLE expedientes
  ADD COLUMN IF NOT EXISTS notas TEXT;

-- 2. Agregar columna creado_por (usuario que creo el expediente)
ALTER TABLE expedientes
  ADD COLUMN IF NOT EXISTS creado_por UUID REFERENCES perfiles(id);

-- 3. Indice para creado_por
CREATE INDEX IF NOT EXISTS idx_expedientes_creado_por ON expedientes(creado_por);

-- 4. Tabla de secuencia anual para codigos EXP-YYYY-NNNN
CREATE TABLE IF NOT EXISTS expediente_yearly_seq (
  year INT PRIMARY KEY,
  last_number INT NOT NULL DEFAULT 0
);

-- 5. Reemplazar funcion de generacion de codigo para usar secuencia anual atomica
CREATE OR REPLACE FUNCTION generar_numero_expediente()
RETURNS TRIGGER AS $$
DECLARE
  current_year INT;
  next_number INT;
BEGIN
  IF NEW.numero IS NULL THEN
    current_year := EXTRACT(YEAR FROM NOW())::INT;

    -- Atomico: INSERT si no existe el anio, UPDATE si existe
    INSERT INTO expediente_yearly_seq (year, last_number)
    VALUES (current_year, 1)
    ON CONFLICT (year)
    DO UPDATE SET last_number = expediente_yearly_seq.last_number + 1
    RETURNING last_number INTO next_number;

    NEW.numero = 'EXP-' || current_year::TEXT || '-' || LPAD(next_number::TEXT, 4, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 6. RPC para listar expedientes con relaciones y busqueda cross-table
CREATE OR REPLACE FUNCTION list_expedientes_with_relations(
  p_search TEXT DEFAULT NULL,
  p_estados TEXT[] DEFAULT NULL,
  p_analista_id UUID DEFAULT NULL,
  p_fecha_desde TIMESTAMPTZ DEFAULT NULL,
  p_fecha_hasta TIMESTAMPTZ DEFAULT NULL,
  p_sort_field TEXT DEFAULT 'created_at',
  p_sort_direction TEXT DEFAULT 'desc',
  p_limit INT DEFAULT 20,
  p_offset INT DEFAULT 0
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result JSON;
  total_count BIGINT;
BEGIN
  -- Contar total de registros que coinciden con los filtros
  SELECT COUNT(*)
  INTO total_count
  FROM expedientes e
  LEFT JOIN inmuebles i ON i.id = e.inmueble_id
  LEFT JOIN solicitantes s ON s.id = e.solicitante_id
  WHERE (p_estados IS NULL OR e.estado::TEXT = ANY(p_estados))
    AND (p_analista_id IS NULL OR e.analista_id = p_analista_id)
    AND (p_fecha_desde IS NULL OR e.created_at >= p_fecha_desde)
    AND (p_fecha_hasta IS NULL OR e.created_at <= p_fecha_hasta)
    AND (p_search IS NULL OR (
      e.numero ILIKE '%' || p_search || '%'
      OR s.nombre ILIKE '%' || p_search || '%'
      OR s.apellido ILIKE '%' || p_search || '%'
      OR i.direccion ILIKE '%' || p_search || '%'
      OR i.codigo ILIKE '%' || p_search || '%'
    ));

  -- Obtener datos paginados con relaciones
  SELECT json_build_object(
    'data', COALESCE(json_agg(sub.row_data), '[]'::json),
    'total', total_count
  ) INTO result
  FROM (
    SELECT json_build_object(
      'id', e.id,
      'numero', e.numero,
      'estado', e.estado,
      'notas', e.notas,
      'codeudor_nombre', e.codeudor_nombre,
      'codeudor_tipo_documento', e.codeudor_tipo_documento,
      'codeudor_documento', e.codeudor_documento,
      'codeudor_parentesco', e.codeudor_parentesco,
      'analista_id', e.analista_id,
      'inmueble_id', e.inmueble_id,
      'solicitante_id', e.solicitante_id,
      'creado_por', e.creado_por,
      'created_at', e.created_at,
      'updated_at', e.updated_at,
      'inmueble', json_build_object(
        'id', i.id,
        'codigo', i.codigo,
        'direccion', i.direccion,
        'ciudad', i.ciudad,
        'tipo', i.tipo
      ),
      'solicitante', json_build_object(
        'id', s.id,
        'nombre', s.nombre,
        'apellido', s.apellido,
        'tipo_documento', s.tipo_documento,
        'numero_documento', s.numero_documento,
        'email', s.email
      ),
      'analista', CASE WHEN a.id IS NOT NULL THEN json_build_object(
        'id', a.id,
        'nombre', a.nombre,
        'apellido', a.apellido
      ) ELSE NULL END,
      'creador', CASE WHEN c.id IS NOT NULL THEN json_build_object(
        'id', c.id,
        'nombre', c.nombre,
        'apellido', c.apellido
      ) ELSE NULL END
    ) AS row_data
    FROM expedientes e
    LEFT JOIN inmuebles i ON i.id = e.inmueble_id
    LEFT JOIN solicitantes s ON s.id = e.solicitante_id
    LEFT JOIN perfiles a ON a.id = e.analista_id
    LEFT JOIN perfiles c ON c.id = e.creado_por
    WHERE (p_estados IS NULL OR e.estado::TEXT = ANY(p_estados))
      AND (p_analista_id IS NULL OR e.analista_id = p_analista_id)
      AND (p_fecha_desde IS NULL OR e.created_at >= p_fecha_desde)
      AND (p_fecha_hasta IS NULL OR e.created_at <= p_fecha_hasta)
      AND (p_search IS NULL OR (
        e.numero ILIKE '%' || p_search || '%'
        OR s.nombre ILIKE '%' || p_search || '%'
        OR s.apellido ILIKE '%' || p_search || '%'
        OR i.direccion ILIKE '%' || p_search || '%'
        OR i.codigo ILIKE '%' || p_search || '%'
      ))
    ORDER BY
      CASE WHEN p_sort_field = 'created_at' AND p_sort_direction = 'desc' THEN e.created_at END DESC,
      CASE WHEN p_sort_field = 'created_at' AND p_sort_direction = 'asc' THEN e.created_at END ASC,
      CASE WHEN p_sort_field = 'numero' AND p_sort_direction = 'desc' THEN e.numero END DESC,
      CASE WHEN p_sort_field = 'numero' AND p_sort_direction = 'asc' THEN e.numero END ASC,
      CASE WHEN p_sort_field = 'estado' AND p_sort_direction = 'desc' THEN e.estado::TEXT END DESC,
      CASE WHEN p_sort_field = 'estado' AND p_sort_direction = 'asc' THEN e.estado::TEXT END ASC
    LIMIT p_limit
    OFFSET p_offset
  ) sub;

  RETURN result;
END;
$$;
