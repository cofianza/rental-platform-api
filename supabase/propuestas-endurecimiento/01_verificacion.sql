-- Verificación de E1 · correr en el SQL Editor DESPUÉS de aplicar la 01.
-- Cada bloque es independiente (córrelos uno por uno). Ninguno escribe:
-- todos terminan en ROLLBACK.

-- 1) Permisos y configuración. Esperado: anon=false, public=false,
--    authenticated=true, service_role=true, proconfig={search_path=""}
SELECT has_function_privilege('anon',          'public.get_my_role()', 'EXECUTE') AS anon,
       has_function_privilege('public',        'public.get_my_role()', 'EXECUTE') AS public,
       has_function_privilege('authenticated', 'public.get_my_role()', 'EXECUTE') AS authenticated,
       has_function_privilege('service_role',  'public.get_my_role()', 'EXECUTE') AS service_role,
       (SELECT proconfig FROM pg_proc WHERE oid = 'public.get_my_role()'::regprocedure) AS proconfig;

-- 2) anon NO puede ejecutarla. Esperado: ERROR "permission denied for function get_my_role"
BEGIN;
SET LOCAL ROLE anon;
SELECT public.get_my_role();
ROLLBACK;

-- 3) authenticated SÍ. Esperado: una fila con NULL (sin usuario en el JWT) y sin error.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT public.get_my_role() AS rol;
ROLLBACK;

-- 4) Las políticas que la usan siguen evaluando. Esperado: 0 y sin error
--    (authenticated sin usuario no ve filas; un error aquí = rollback YA).
BEGIN;
SET LOCAL ROLE authenticated;
SELECT count(*) FROM public.expedientes;
ROLLBACK;

-- 5) Con un usuario real devuelve su rol. Reemplazar <uuid> por el id de un
--    perfil interno. Esperado: su rol (p. ej. administrador).
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"<uuid>","role":"authenticated"}', true);
SELECT public.get_my_role() AS rol;
ROLLBACK;
