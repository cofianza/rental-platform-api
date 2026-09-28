-- E1 · get_my_role(): search_path vacío y sin EXECUTE para PUBLIC ni anon.
-- Riesgo de romper: NULO para la app (la web no usa PostgREST; la API es
-- service_role). Las políticas de `authenticated` la siguen pudiendo llamar.
-- PRECONDICIÓN: el cuerpo de producción es este mismo. Comprobar antes con
--   SELECT pg_get_functiondef('public.get_my_role()'::regprocedure);
-- (CREATE OR REPLACE reescribe el cuerpo; con search_path = '' todo nombre
-- debe ir calificado: public.perfiles, auth.uid()).
CREATE OR REPLACE FUNCTION public.get_my_role()
  RETURNS public.rol_usuario
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = ''
AS $f$ SELECT rol FROM public.perfiles WHERE id = auth.uid() $f$;

REVOKE EXECUTE ON FUNCTION public.get_my_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_role() TO authenticated, service_role;

-- Verificación: false, true, search_path=""
--   SELECT has_function_privilege('anon', 'public.get_my_role()', 'EXECUTE'),
--          has_function_privilege('authenticated', 'public.get_my_role()', 'EXECUTE'),
--          (SELECT proconfig FROM pg_proc WHERE oid = 'public.get_my_role()'::regprocedure);
-- Rollback: ALTER FUNCTION public.get_my_role() RESET search_path;
--           GRANT EXECUTE ON FUNCTION public.get_my_role() TO PUBLIC, anon;
