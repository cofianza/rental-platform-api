-- ============================================================
-- Renombrar columnas legacy `codeudor_*` → `coarrendatario_*` en expedientes.
--
-- Mario (5-may-2026): la promesa "rentar sin fiador" implica que en el
-- contrato no aparece la figura "codeudor" sino "coarrendatario" (la
-- persona con la que se vive y respaldamos juntos).
--
-- La plantilla del contrato HTML ya usa `{{coarrendatario.*}}` —
-- el código intermedio (contratos.service.ts) leía codeudor_* y las
-- mapeaba como coarrendatario al renderizar. Renombrar las columnas
-- elimina la traducción y hace que BD ↔ template hablen el mismo idioma.
--
-- ALTER COLUMN RENAME es no-op para los datos existentes — solo cambia
-- el nombre. Cualquier valor "codeudor" guardado en producción queda
-- bajo `coarrendatario_*` (si te importa el matiz histórico, hay que
-- mover esos registros antes; en este proyecto se acordó renombrar).
-- ============================================================

ALTER TABLE expedientes
  RENAME COLUMN codeudor_nombre         TO coarrendatario_nombre;

ALTER TABLE expedientes
  RENAME COLUMN codeudor_tipo_documento TO coarrendatario_tipo_documento;

ALTER TABLE expedientes
  RENAME COLUMN codeudor_documento      TO coarrendatario_documento;

ALTER TABLE expedientes
  RENAME COLUMN codeudor_parentesco     TO coarrendatario_parentesco;

-- ============================================================
-- Regenerar RPC `list_expedientes_with_relations` con los nombres
-- nuevos. Sin esto el listado se rompe (la RPC referenciaba
-- `e.codeudor_nombre` etc. en json_build_object).
-- ============================================================

CREATE OR REPLACE FUNCTION list_expedientes_with_relations(
  p_search TEXT DEFAULT NULL,
  p_estados TEXT[] DEFAULT NULL,
  p_analista_id UUID DEFAULT NULL,
  p_inmueble_id UUID DEFAULT NULL,
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
  SELECT COUNT(*)
  INTO total_count
  FROM expedientes e
  LEFT JOIN inmuebles i ON i.id = e.inmueble_id
  LEFT JOIN solicitantes s ON s.id = e.solicitante_id
  WHERE (p_estados IS NULL OR e.estado::TEXT = ANY(p_estados))
    AND (p_analista_id IS NULL OR e.analista_id = p_analista_id)
    AND (p_inmueble_id IS NULL OR e.inmueble_id = p_inmueble_id)
    AND (p_fecha_desde IS NULL OR e.created_at >= p_fecha_desde)
    AND (p_fecha_hasta IS NULL OR e.created_at <= p_fecha_hasta)
    AND (p_search IS NULL OR (
      e.numero ILIKE '%' || p_search || '%'
      OR s.nombre ILIKE '%' || p_search || '%'
      OR s.apellido ILIKE '%' || p_search || '%'
      OR i.direccion ILIKE '%' || p_search || '%'
      OR i.codigo ILIKE '%' || p_search || '%'
    ));

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
      'coarrendatario_nombre', e.coarrendatario_nombre,
      'coarrendatario_tipo_documento', e.coarrendatario_tipo_documento,
      'coarrendatario_documento', e.coarrendatario_documento,
      'coarrendatario_parentesco', e.coarrendatario_parentesco,
      'analista_id', e.analista_id,
      'inmueble_id', e.inmueble_id,
      'solicitante_id', e.solicitante_id,
      'creado_por', e.creado_por,
      'created_at', e.created_at,
      'updated_at', e.updated_at,
      'cita_realizada', EXISTS (
        SELECT 1 FROM citas c
        WHERE c.expediente_id = e.id AND c.estado = 'realizada'
      ),
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
      AND (p_inmueble_id IS NULL OR e.inmueble_id = p_inmueble_id)
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
