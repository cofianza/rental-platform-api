-- ============================================================
-- Higiene de permisos (sin urgencia): la función de trigger de la Entrega 6
-- nació ejecutable por PUBLIC (y por herencia, por anon y authenticated).
--
-- Por qué pasó: el ALTER DEFAULT PRIVILEGES IN SCHEMA public de
-- 20260922000002 quitó los GRANT explícitos a anon/authenticated, pero en
-- Postgres los privilegios por defecto POR ESQUEMA solo SUMAN a los globales:
-- el EXECUTE a PUBLIC de cada función nueva sigue llegando. Por eso cada
-- migración que cree una función SECURITY DEFINER debe revocarle PUBLIC.
--
-- Sin riesgo hoy: una función que devuelve `trigger` no se puede llamar por
-- /rest/v1/rpc. Se revoca para que el Security Advisor quede limpio. El
-- trigger sigue funcionando: al dispararse no se revisa EXECUTE.
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.fn_expediente_cierre_requiere_acta() FROM PUBLIC, anon, authenticated;

-- Verificación (debe devolver 0 filas):
--   SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.prosecdef
--     AND p.proname NOT IN ('get_my_role', 'handle_new_user', 'rls_auto_enable')
--     AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
