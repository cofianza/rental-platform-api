-- ============================================================
-- Re-alinear funciones DESINCRONIZADAS (drift BD ↔ repo)
-- ------------------------------------------------------------
-- Auditoría 25-jun-2026: el cuerpo DESPLEGADO de estas dos funciones difiere de
-- las migraciones del repo (mismo patrón de drift que handle_new_user). Esta
-- migración re-aplica la versión correcta. Idempotente.
--
--   1) transicionar_expediente: la versión en la BD tiene la máquina de estados
--      VIEJA → bloquea 'en_revision'->'cerrado' (cancelar en revisión) y
--      'condicionado'->'aprobado'/'rechazado' (resolver manualmente un estudio
--      condicionado), devolviendo 400. Reaplica el fix de 20260505000002.
--
--   2) list_users_with_email: la versión en la BD usa SQL DINÁMICO con el
--      parámetro de búsqueda SIN sanitizar → superficie de SQL injection en
--      GET /api/v1/users (?search=). Reaplica la versión ESTÁTICA/parametrizada
--      del repo (20260218000002), que además restaura los tipos enum de salida.
-- ============================================================

-- 1) transicionar_expediente (overload de 5 args = el que invoca el runtime) ----
CREATE OR REPLACE FUNCTION public.transicionar_expediente(
  p_expediente_id UUID,
  p_nuevo_estado estado_expediente,
  p_descripcion TEXT,
  p_usuario_id UUID,
  p_comentario TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
  v_estado_anterior estado_expediente;
  v_expediente RECORD;
  v_evento_id UUID;
  v_transicion_valida BOOLEAN;
BEGIN
  SELECT estado INTO v_estado_anterior
  FROM expedientes
  WHERE id = p_expediente_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expediente no encontrado: %', p_expediente_id;
  END IF;

  v_transicion_valida := CASE v_estado_anterior
    WHEN 'borrador'                THEN p_nuevo_estado IN ('en_revision', 'cerrado')
    WHEN 'en_revision'             THEN p_nuevo_estado IN ('informacion_incompleta', 'aprobado', 'rechazado', 'condicionado', 'cerrado')
    WHEN 'informacion_incompleta'  THEN p_nuevo_estado IN ('en_revision', 'cerrado')
    WHEN 'aprobado'                THEN p_nuevo_estado IN ('cerrado')
    WHEN 'rechazado'               THEN p_nuevo_estado IN ('cerrado')
    WHEN 'condicionado'            THEN p_nuevo_estado IN ('aprobado', 'rechazado', 'en_revision', 'cerrado')
    WHEN 'cerrado'                 THEN FALSE
    ELSE FALSE
  END;

  IF NOT v_transicion_valida THEN
    RAISE EXCEPTION 'Transicion no permitida: % -> %', v_estado_anterior, p_nuevo_estado;
  END IF;

  UPDATE expedientes
  SET estado = p_nuevo_estado,
      updated_at = NOW()
  WHERE id = p_expediente_id
  RETURNING * INTO v_expediente;

  INSERT INTO eventos_timeline (
    expediente_id, tipo, descripcion, usuario_id,
    estado_anterior, estado_nuevo, comentario
  )
  VALUES (
    p_expediente_id, 'estado', p_descripcion, p_usuario_id,
    v_estado_anterior, p_nuevo_estado, p_comentario
  )
  RETURNING id INTO v_evento_id;

  RETURN json_build_object(
    'expediente_id', p_expediente_id,
    'estado_anterior', v_estado_anterior,
    'estado_nuevo', p_nuevo_estado,
    'evento_timeline_id', v_evento_id,
    'updated_at', v_expediente.updated_at
  );
END;
$$;

-- 2) list_users_with_email — versión estática parametrizada (anti SQL injection) ----
-- DROP necesario: el cuerpo desplegado devuelve TEXT en algunas columnas y aquí
-- restauramos los tipos enum → no se puede CREATE OR REPLACE con distinto retorno.
DROP FUNCTION IF EXISTS public.list_users_with_email(TEXT, TEXT, TEXT, TEXT, TEXT, INT, INT);

CREATE OR REPLACE FUNCTION public.list_users_with_email(
  search_term TEXT DEFAULT NULL,
  filter_rol TEXT DEFAULT NULL,
  filter_estado TEXT DEFAULT NULL,
  sort_field TEXT DEFAULT 'created_at',
  sort_direction TEXT DEFAULT 'desc',
  page_limit INT DEFAULT 10,
  page_offset INT DEFAULT 0
)
RETURNS TABLE(
  id UUID,
  email TEXT,
  nombre VARCHAR(100),
  apellido VARCHAR(100),
  telefono VARCHAR(20),
  tipo_documento public.tipo_documento_id,
  numero_documento VARCHAR(20),
  rol public.rol_usuario,
  estado public.estado_usuario,
  avatar_url TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  total_count BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  SELECT
    p.id,
    au.email::TEXT,
    p.nombre,
    p.apellido,
    p.telefono,
    p.tipo_documento,
    p.numero_documento,
    p.rol,
    p.estado,
    p.avatar_url,
    p.created_at,
    p.updated_at,
    COUNT(*) OVER() AS total_count
  FROM public.perfiles p
  INNER JOIN auth.users au ON au.id = p.id
  WHERE
    (search_term IS NULL OR (
      p.nombre ILIKE '%' || search_term || '%' OR
      p.apellido ILIKE '%' || search_term || '%' OR
      au.email ILIKE '%' || search_term || '%'
    ))
    AND (filter_rol IS NULL OR p.rol::TEXT = filter_rol)
    AND (filter_estado IS NULL OR p.estado::TEXT = filter_estado)
  ORDER BY
    CASE WHEN sort_field = 'nombre'     AND sort_direction = 'asc'  THEN p.nombre END ASC,
    CASE WHEN sort_field = 'nombre'     AND sort_direction = 'desc' THEN p.nombre END DESC,
    CASE WHEN sort_field = 'apellido'   AND sort_direction = 'asc'  THEN p.apellido END ASC,
    CASE WHEN sort_field = 'apellido'   AND sort_direction = 'desc' THEN p.apellido END DESC,
    CASE WHEN sort_field = 'rol'        AND sort_direction = 'asc'  THEN p.rol::TEXT END ASC,
    CASE WHEN sort_field = 'rol'        AND sort_direction = 'desc' THEN p.rol::TEXT END DESC,
    CASE WHEN sort_field = 'estado'     AND sort_direction = 'asc'  THEN p.estado::TEXT END ASC,
    CASE WHEN sort_field = 'estado'     AND sort_direction = 'desc' THEN p.estado::TEXT END DESC,
    CASE WHEN sort_field = 'created_at' AND sort_direction = 'asc'  THEN p.created_at END ASC,
    CASE WHEN sort_field = 'created_at' AND sort_direction = 'desc' THEN p.created_at END DESC,
    p.created_at DESC
  LIMIT page_limit OFFSET page_offset;
END;
$$;
