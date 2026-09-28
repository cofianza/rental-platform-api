-- E1 · get_my_role(): search_path vacío y sin EXECUTE para PUBLIC ni anon.
-- Riesgo de romper: NULO para la app (la web no usa PostgREST; la API es
-- service_role). Las políticas de `authenticated` la siguen pudiendo llamar.
-- No reescribe el cuerpo: el de producción ya califica todo
-- (SELECT rol FROM public.perfiles WHERE id = auth.uid()), así que basta el ALTER.
ALTER FUNCTION public.get_my_role() SET search_path = '';

REVOKE EXECUTE ON FUNCTION public.get_my_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_role() TO authenticated, service_role;

-- Verificación: false, true, {search_path=""}
--   SELECT has_function_privilege('anon', 'public.get_my_role()', 'EXECUTE'),
--          has_function_privilege('authenticated', 'public.get_my_role()', 'EXECUTE'),
--          (SELECT proconfig FROM pg_proc WHERE oid = 'public.get_my_role()'::regprocedure);
-- Rollback: ALTER FUNCTION public.get_my_role() RESET search_path;
--           GRANT EXECUTE ON FUNCTION public.get_my_role() TO PUBLIC, anon;
