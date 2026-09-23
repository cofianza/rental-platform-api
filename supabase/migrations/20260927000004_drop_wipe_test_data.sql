-- ============================================================
-- Seguridad: fuera la función que borraba TODOS los datos de la plataforma.
--
-- fn_wipe_test_data (migración 20260507000005, "TEMPORAL — eliminar antes de
-- producción") borraba facturas (reales ante la DIAN desde el 2026-09-18),
-- pagos, contratos, estudios, citas, moras y bitácora. El botón del panel y el
-- endpoint /admin-tools/wipe-test-data se retiraron el 2026-09-22 (mismo
-- commit); sin la función no queda forma de dispararla por error.
-- ============================================================

DROP FUNCTION IF EXISTS public.fn_wipe_test_data();

-- Verificación (debe devolver 0):
--   SELECT count(*) FROM pg_proc WHERE proname = 'fn_wipe_test_data';
