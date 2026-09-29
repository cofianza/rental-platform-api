-- E5 · Segunda defensa: anon y authenticated sin permisos sobre las tablas,
-- vistas y secuencias de public, aunque alguien apague RLS. Solo queda SELECT
-- en notificaciones para Realtime.
-- Riesgo de romper: MEDIO (toca todo public y los defaults de tablas futuras).
-- Probar primero en staging: login, campanita en vivo, vitrina pública, fotos.
--
-- Alcance real (no promete más):
--   - Quita los permisos de hoy sobre TABLES y SEQUENCES (ALL TABLES incluye vistas).
--   - Quita los default privileges en public de CADA rol que hoy se los regala a
--     anon/authenticated (en Supabase: postgres y, casi siempre, supabase_admin).
--     Si el rol que corre esto no puede cambiar los de otro rol (postgres no es
--     miembro de supabase_admin), sale un WARNING con el nombre y ese rol queda
--     igual: sus tablas nuevas seguirían naciendo con permisos. RLS sigue siendo
--     la primera defensa. Los defaults GLOBALES (sin IN SCHEMA) no se tocan; la
--     verificación 2 los muestra si existen.
--   - NO toca FUNCTIONS (EXECUTE de anon sobre funciones se evalúa aparte).
--
-- Rollback EXACTO: 05_rollback.sql. Restaura las ACL guardadas en el paso 0
-- (tablas, vistas, secuencias, columnas y default privileges), tal cual estaban.
-- NO usar un «GRANT ALL ON ALL TABLES … TO anon, authenticated»: deshace los
-- REVOKE de perfiles y bitacora (20260927000003) y de v_estudios_sombra_vs_real
-- (20261001000012), que eran más estrictos.

BEGIN;

-- 0. Foto de las ACL de antes. CREATE … IF NOT EXISTS: si E5 se corre dos
--    veces, la foto sigue siendo la de ANTES de la primera vez.
CREATE SCHEMA IF NOT EXISTS respaldo_e5;
REVOKE ALL ON SCHEMA respaldo_e5 FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS respaldo_e5.acl_objetos AS
  SELECT c.relname, c.relkind, c.relacl, now() AS guardado_en
  FROM pg_class c
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S');

CREATE TABLE IF NOT EXISTS respaldo_e5.acl_columnas AS
  SELECT c.relname, a.attname, a.attacl
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
  WHERE c.relnamespace = 'public'::regnamespace AND a.attnum > 0 AND NOT a.attisdropped
    AND a.attacl IS NOT NULL;

CREATE TABLE IF NOT EXISTS respaldo_e5.default_acl AS
  SELECT d.defaclrole::regrole::text AS rol, d.defaclobjtype, d.defaclacl
  FROM pg_default_acl d
  WHERE d.defaclnamespace = 'public'::regnamespace;

-- 1. Permisos de hoy.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
GRANT SELECT ON public.notificaciones TO authenticated;

-- 2. Default privileges de cada rol que hoy regala permisos en public.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT d.defaclrole::regrole::text AS rol
    FROM pg_default_acl d, aclexplode(d.defaclacl) a
    WHERE d.defaclnamespace = 'public'::regnamespace
      AND d.defaclobjtype IN ('r', 'S')
      AND a.grantee::regrole::text IN ('anon', 'authenticated')
  LOOP
    BEGIN
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %s IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated', r.rol);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %s IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated', r.rol);
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE WARNING 'E5: no se pudieron quitar los default privileges de % en public (hace falta ser ese rol o miembro de él). Sus tablas nuevas seguirán naciendo con permisos para anon/authenticated.', r.rol;
    END;
  END LOOP;
END $$;

COMMIT;

-- Verificación 1: solo notificaciones / SELECT / authenticated
--   SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
--   WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated');
-- Verificación 2: 0 filas (si sale un rol, ver el WARNING del paso 2)
--   SELECT d.defaclrole::regrole, d.defaclnamespace::regnamespace, d.defaclobjtype, a.grantee::regrole, a.privilege_type
--   FROM pg_default_acl d, aclexplode(d.defaclacl) a
--   WHERE d.defaclobjtype IN ('r', 'S') AND a.grantee::regrole::text IN ('anon', 'authenticated');
-- Verificación 3: la foto quedó guardada (debe dar > 0)
--   SELECT count(*) FROM respaldo_e5.acl_objetos;
