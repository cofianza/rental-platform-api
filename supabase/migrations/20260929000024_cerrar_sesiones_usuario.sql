-- ============================================================
-- Cerrar todas las sesiones de un usuario desde el API
--
-- Desactivar una cuenta, restablecer la contraseña desde /usuarios o por el
-- enlace del correo "cerraban todas las sesiones" con
-- auth.admin.signOut(userId, 'global'). Pero supabase-js pide ahí el JWT del
-- usuario, no su id: GoTrue respondía 401 y no se cerraba nada. Quien tenía la
-- sesión abierta (refresh de 30 días) seguía adentro.
--
-- La API de admin de GoTrue no tiene "cerrar sesiones por id", así que se
-- borran sus filas de auth.sessions (los refresh tokens caen en cascada; el
-- DELETE de refresh_tokens cubre los viejos sin session_id). Con la sesión
-- borrada, GoTrue ya no acepta su access token (session_not_found).
--
-- El API funciona antes y después de correrla: sin la función, la llamada
-- falla, queda en el log y el flujo sigue como hoy.
-- Solo service_role. Idempotente.
-- ============================================================

CREATE OR REPLACE FUNCTION public.cerrar_sesiones_usuario(p_user_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  DELETE FROM auth.refresh_tokens WHERE user_id = p_user_id::text;
  DELETE FROM auth.sessions WHERE user_id = p_user_id;
$$;

REVOKE EXECUTE ON FUNCTION public.cerrar_sesiones_usuario(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cerrar_sesiones_usuario(uuid) TO service_role;

-- Verificación (debe devolver false, false, true):
--   SELECT has_function_privilege('anon', 'public.cerrar_sesiones_usuario(uuid)', 'EXECUTE'),
--          has_function_privilege('authenticated', 'public.cerrar_sesiones_usuario(uuid)', 'EXECUTE'),
--          has_function_privilege('service_role', 'public.cerrar_sesiones_usuario(uuid)', 'EXECUTE');
