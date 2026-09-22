-- ============================================================
-- URGENTE — seguridad: funciones SECURITY DEFINER ejecutables sin login.
--
-- Supabase expone el esquema public por REST (/rest/v1/rpc/<funcion>) y la
-- anon key es pública (va en la web). Por los privilegios por defecto, estas
-- funciones SECURITY DEFINER (corren como su dueño, saltándose RLS) quedaron
-- ejecutables por `anon` (cualquiera en internet) y por `authenticated`
-- (cualquiera que se registre). Lo confirma el Security Advisor de Supabase
-- (lint 0028/0029). Consecuencias hoy:
--   - fn_wipe_test_data(): BORRA facturas, contratos, firmas, pagos… de todo el sistema.
--   - update_inmueble_con_cambios(): modifica cualquier inmueble.
--   - list_expedientes_with_relations(): lista todos los estudios con datos del solicitante.
--   - list_users_with_email / find_user_by_email / get_user_with_email: correos de auth.users.
--   - search_inmueble_ids(): ids de inmuebles.
--
-- Nadie legítimo las llama con esos roles: la web no hace .rpc() y la API usa
-- service_role, que tiene su propio GRANT explícito (se conserva).
-- No se tocan: get_my_role() (la usan las políticas RLS de `authenticated`;
-- solo devuelve el rol de quien llama), handle_new_user() y rls_auto_enable()
-- (funciones de trigger: llamarlas por RPC falla).
--
-- Idempotente. Correr YA, independiente de la Entrega 5.
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.fn_wipe_test_data() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_inmueble_con_cambios(uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.list_expedientes_with_relations(
  text, text[], uuid, uuid, timestamptz, timestamptz, text, text, integer, integer, text, uuid[], uuid
) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.list_users_with_email(text, text, text, text, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.find_user_by_email(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_user_with_email(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.search_inmueble_ids(text) FROM PUBLIC, anon, authenticated;

-- Que no vuelva a pasar: las funciones que se creen desde ahora (con el rol que
-- corre este archivo, postgres en el SQL editor) ya no nacen ejecutables por
-- anon/authenticated. service_role sigue recibiendo su GRANT por defecto.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;

-- Verificación (debe devolver 0 filas):
--   SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.prosecdef
--     AND p.proname NOT IN ('get_my_role', 'handle_new_user', 'rls_auto_enable')
--     AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
-- Y la API sigue pudiendo (debe devolver true en las 7):
--   SELECT p.proname, has_function_privilege('service_role', p.oid, 'EXECUTE') FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prosecdef;
--
-- ROLLBACK (no recomendado): GRANT EXECUTE ON FUNCTION … TO anon, authenticated;
