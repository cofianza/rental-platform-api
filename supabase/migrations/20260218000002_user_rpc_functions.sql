-- ============================================================
-- Migracion: Funciones RPC para CRUD de usuarios (HP-107)
-- Fecha: 2026-02-18
-- ============================================================

-- ============================================================
-- 1. list_users_with_email
-- Lista usuarios con email (JOIN auth.users), filtros y paginacion.
-- Retorna total_count en cada fila para paginacion eficiente.
-- ============================================================

DROP FUNCTION IF EXISTS list_users_with_email(TEXT, TEXT, TEXT, TEXT, TEXT, INT, INT);

CREATE OR REPLACE FUNCTION list_users_with_email(
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
    CASE WHEN sort_field = 'nombre' AND sort_direction = 'asc' THEN p.nombre END ASC,
    CASE WHEN sort_field = 'nombre' AND sort_direction = 'desc' THEN p.nombre END DESC,
    CASE WHEN sort_field = 'apellido' AND sort_direction = 'asc' THEN p.apellido END ASC,
    CASE WHEN sort_field = 'apellido' AND sort_direction = 'desc' THEN p.apellido END DESC,
    CASE WHEN sort_field = 'rol' AND sort_direction = 'asc' THEN p.rol::TEXT END ASC,
    CASE WHEN sort_field = 'rol' AND sort_direction = 'desc' THEN p.rol::TEXT END DESC,
    CASE WHEN sort_field = 'estado' AND sort_direction = 'asc' THEN p.estado::TEXT END ASC,
    CASE WHEN sort_field = 'estado' AND sort_direction = 'desc' THEN p.estado::TEXT END DESC,
    CASE WHEN sort_field = 'created_at' AND sort_direction = 'asc' THEN p.created_at END ASC,
    CASE WHEN sort_field = 'created_at' AND sort_direction = 'desc' THEN p.created_at END DESC,
    p.created_at DESC
  LIMIT page_limit OFFSET page_offset;
END;
$$;

-- ============================================================
-- 2. get_user_with_email
-- Retorna un usuario con su email por ID.
-- ============================================================

DROP FUNCTION IF EXISTS get_user_with_email(UUID);

CREATE OR REPLACE FUNCTION get_user_with_email(user_id UUID)
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
  updated_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
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
    p.updated_at
  FROM public.perfiles p
  INNER JOIN auth.users au ON au.id = p.id
  WHERE p.id = user_id;
$$;
