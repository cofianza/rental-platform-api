-- Bloque 5 · get_my_role() devuelve el rol real de un usuario interno.
-- Toma el id de un administrador sin mostrarlo, lo pone como usuario del JWT
-- y ejecuta como authenticated. No escribe nada (ROLLBACK).
-- Esperado: rol = administrador y expedientes_visibles > 0
-- (la política expedientes_select_internal evalúa con get_my_role()).
BEGIN;
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', (SELECT id FROM public.perfiles WHERE rol = 'administrador' ORDER BY created_at LIMIT 1),
    'role', 'authenticated'
  )::text,
  true
) IS NOT NULL AS jwt_listo;
SET LOCAL ROLE authenticated;
SELECT public.get_my_role() AS rol,
       (SELECT count(*) FROM public.expedientes) AS expedientes_visibles;
ROLLBACK;
