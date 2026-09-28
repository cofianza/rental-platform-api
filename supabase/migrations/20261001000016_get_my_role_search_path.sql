-- ============================================================
-- get_my_role(): search_path vacío y sin EXECUTE para PUBLIC ni anon.
-- APLICADA EN PRODUCCIÓN el 2026-09-28 (por el usuario, SQL Editor) y
-- verificada (propuestas-endurecimiento/01_verificacion.sql, bloques 1-4).
--
-- Idempotente: ALTER/REVOKE/GRANT dan el mismo estado si se repiten.
-- No reescribe el cuerpo: el de producción ya califica todo
-- (SELECT rol FROM public.perfiles WHERE id = auth.uid()).
-- Las políticas de `authenticated` la siguen pudiendo llamar.
-- Rollback: propuestas-endurecimiento/01_rollback.sql
-- ============================================================
ALTER FUNCTION public.get_my_role() SET search_path = '';

REVOKE EXECUTE ON FUNCTION public.get_my_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_role() TO authenticated, service_role;
