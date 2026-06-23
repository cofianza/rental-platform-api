-- ============================================================
-- Scoping multi-tenant DENTRO del RPC de listado de expedientes.
--
-- Antes: list_expedientes_with_relations devolvía una página GLOBAL (todos los
-- expedientes de la plataforma) y el controller post-filtraba en JS por los IDs
-- accesibles del usuario y RECALCULABA total/totalPages sobre el slice. Eso
-- rompía la paginación (una inmobiliaria pedía 20 y recibía 0-3 filas, con un
-- total incorrecto) y ejecutaba un RPC caro para tirar la mayoría de filas.
--
-- Ahora: el RPC recibe `p_allowed_expediente_ids UUID[]` y filtra + cuenta +
-- pagina en SQL:
--   - NULL  -> sin filtro (roles internos: admin/operador/gerencia ven todo).
--   - [...] -> SOLO esos expedientes (propietario/inmobiliaria/solicitante).
-- El controller resuelve esos IDs (org-aware) y NUNCA pasa [] (cortocircuita
-- antes), así no hay ambigüedad de serialización array-vacío vs NULL.
--
-- RETROCOMPATIBLE: el parámetro nuevo va al final con DEFAULT NULL, así que el
-- código ACTUAL (que aún no lo pasa) sigue funcionando contra esta función →
-- la migración se puede correr ANTES de desplegar el código nuevo.
--
-- Se DROPea la firma de 11 args (la de 20260623000001) para dejar UNA sola
-- función (12 args). Cambiar el nº de args crea un OVERLOAD nuevo en vez de
-- reemplazar; coexistir dos firmas vuelve ambiguas las llamadas con menos args.
-- ============================================================

-- Firma de 11 args (sin p_allowed_expediente_ids) — la dejamos ir.
DROP FUNCTION IF EXISTS list_expedientes_with_relations(
  text, text[], uuid, uuid, timestamptz, timestamptz, text, text, integer, integer, text
);

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
  p_offset INT DEFAULT 0,
  p_estudio_filtro TEXT DEFAULT NULL,
  p_allowed_expediente_ids UUID[] DEFAULT NULL
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
  LEFT JOIN LATERAL (
    SELECT es.estado::TEXT AS estado, es.resultado::TEXT AS resultado, es.score, es.created_at
    FROM estudios es
    WHERE es.expediente_id = e.id
    ORDER BY es.created_at DESC
    LIMIT 1
  ) ev ON TRUE
  WHERE (p_allowed_expediente_ids IS NULL OR e.id = ANY(p_allowed_expediente_ids))
    AND (p_estados IS NULL OR e.estado::TEXT = ANY(p_estados))
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
    AND (
      p_estudio_filtro IS NULL OR p_estudio_filtro = 'todos'
      OR (p_estudio_filtro = 'aprobado' AND ev.resultado = 'aprobado')
      OR (p_estudio_filtro = 'rechazado' AND ev.resultado = 'rechazado')
      OR (p_estudio_filtro = 'condicionado' AND ev.resultado = 'condicionado')
      OR (p_estudio_filtro = 'en_proceso' AND ev.created_at IS NOT NULL AND ev.resultado = 'pendiente')
      OR (p_estudio_filtro = 'sin_estudio' AND ev.created_at IS NULL)
    );

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
      'cancelado_at', e.cancelado_at,
      'motivo_cancelacion', e.motivo_cancelacion,
      'estado_pre_cancelacion', e.estado_pre_cancelacion,
      'created_at', e.created_at,
      'updated_at', e.updated_at,
      'cita_realizada', EXISTS (
        SELECT 1 FROM citas c
        WHERE c.expediente_id = e.id AND c.estado = 'realizada'
      ),
      'estudio_vigente', CASE WHEN ev.created_at IS NOT NULL THEN json_build_object(
        'estado', ev.estado,
        'resultado', ev.resultado,
        'score', ev.score,
        'created_at', ev.created_at
      ) ELSE NULL END,
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
    LEFT JOIN LATERAL (
      SELECT es.estado::TEXT AS estado, es.resultado::TEXT AS resultado, es.score, es.created_at
      FROM estudios es
      WHERE es.expediente_id = e.id
      ORDER BY es.created_at DESC
      LIMIT 1
    ) ev ON TRUE
    WHERE (p_allowed_expediente_ids IS NULL OR e.id = ANY(p_allowed_expediente_ids))
      AND (p_estados IS NULL OR e.estado::TEXT = ANY(p_estados))
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
      AND (
        p_estudio_filtro IS NULL OR p_estudio_filtro = 'todos'
        OR (p_estudio_filtro = 'aprobado' AND ev.resultado = 'aprobado')
        OR (p_estudio_filtro = 'rechazado' AND ev.resultado = 'rechazado')
        OR (p_estudio_filtro = 'condicionado' AND ev.resultado = 'condicionado')
        OR (p_estudio_filtro = 'en_proceso' AND ev.created_at IS NOT NULL AND ev.resultado = 'pendiente')
        OR (p_estudio_filtro = 'sin_estudio' AND ev.created_at IS NULL)
      )
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
