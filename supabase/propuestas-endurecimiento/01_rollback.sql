-- ROLLBACK de E1 · deja get_my_role() como estaba el 2026-09-28:
-- sin search_path propio (proconfig NULL) y ejecutable por PUBLIC y anon.
--
-- ANTES de aplicar la 01, guardar el ACL exacto (para comparar después):
--   SELECT proacl, proconfig FROM pg_proc WHERE oid = 'public.get_my_role()'::regprocedure;
-- Guardado en producción el 2026-09-28, justo antes de aplicar la 01:
--   proacl = {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--   proconfig = NULL
-- (PUBLIC y anon explícitos: el GRANT de abajo lo deja idéntico).
BEGIN;
ALTER FUNCTION public.get_my_role() RESET search_path;
GRANT EXECUTE ON FUNCTION public.get_my_role() TO PUBLIC, anon;
COMMIT;

-- Verificación del rollback: proconfig NULL y anon = true
--   SELECT proconfig, has_function_privilege('anon', oid, 'EXECUTE') AS anon
--   FROM pg_proc WHERE oid = 'public.get_my_role()'::regprocedure;
