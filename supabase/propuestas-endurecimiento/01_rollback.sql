-- ROLLBACK de E1 · deja get_my_role() como estaba el 2026-09-28:
-- sin search_path propio (proconfig NULL) y ejecutable por PUBLIC y anon.
--
-- ANTES de aplicar la 01, guardar el ACL exacto (para comparar después):
--   SELECT proacl, proconfig FROM pg_proc WHERE oid = 'public.get_my_role()'::regprocedure;
-- Si el proacl guardado NO tenía una entrada para anon (solo PUBLIC, "=X/…"),
-- quitar "anon" del GRANT de abajo para dejarlo idéntico.
BEGIN;
ALTER FUNCTION public.get_my_role() RESET search_path;
GRANT EXECUTE ON FUNCTION public.get_my_role() TO PUBLIC, anon;
COMMIT;

-- Verificación del rollback: proconfig NULL y anon = true
--   SELECT proconfig, has_function_privilege('anon', oid, 'EXECUTE') AS anon
--   FROM pg_proc WHERE oid = 'public.get_my_role()'::regprocedure;
