-- ROLLBACK de E5 · deja los permisos de anon y authenticated sobre public
-- EXACTAMENTE como estaban antes de E5, leyendo la foto que E5 guardó en el
-- esquema respaldo_e5 (paso 0 de 05_revocar_grants_tablas.sql).
--
-- No da nada de más: perfiles, bitacora y v_estudios_sombra_vs_real vuelven a
-- sus REVOKE originales porque la foto ya los tenía. Los objetos creados
-- después de E5 no están en la foto y se dejan como estén.
-- Si falta la foto (E5 no se corrió con este archivo), aborta sin tocar nada.

BEGIN;

DO $$
DECLARE
  r record;
  tipo text;
BEGIN
  IF to_regclass('respaldo_e5.acl_objetos') IS NULL THEN
    RAISE EXCEPTION 'No existe respaldo_e5.acl_objetos: no hay foto de las ACL de antes de E5. No se toca nada.';
  END IF;

  -- 1. Quitar lo que anon/authenticated tengan hoy (p. ej. el SELECT de notificaciones).
  FOR r IN
    SELECT relname, relkind FROM respaldo_e5.acl_objetos
    WHERE to_regclass(format('public.%I', relname)) IS NOT NULL
  LOOP
    tipo := CASE WHEN r.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END;
    EXECUTE format('REVOKE ALL ON %s public.%I FROM anon, authenticated', tipo, r.relname);
  END LOOP;

  -- 2. Devolver lo que tenían, privilegio por privilegio.
  FOR r IN
    SELECT o.relname, o.relkind, a.grantee::regrole::text AS rol, a.privilege_type, a.is_grantable
    FROM respaldo_e5.acl_objetos o, aclexplode(o.relacl) a
    WHERE a.grantee::regrole::text IN ('anon', 'authenticated')
      AND to_regclass(format('public.%I', o.relname)) IS NOT NULL
  LOOP
    tipo := CASE WHEN r.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END;
    EXECUTE format('GRANT %s ON %s public.%I TO %s%s', r.privilege_type, tipo, r.relname, r.rol,
      CASE WHEN r.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;

  -- 3. Permisos por columna (el REVOKE ALL de tabla también los había quitado).
  FOR r IN
    SELECT c.relname, c.attname, a.grantee::regrole::text AS rol, a.privilege_type, a.is_grantable
    FROM respaldo_e5.acl_columnas c, aclexplode(c.attacl) a
    WHERE a.grantee::regrole::text IN ('anon', 'authenticated')
      AND to_regclass(format('public.%I', c.relname)) IS NOT NULL
  LOOP
    EXECUTE format('GRANT %s (%I) ON TABLE public.%I TO %s%s', r.privilege_type, r.attname, r.relname, r.rol,
      CASE WHEN r.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;

  -- 4. Default privileges en public, rol por rol.
  FOR r IN
    SELECT d.rol, d.defaclobjtype, a.grantee::regrole::text AS gr, a.privilege_type
    FROM respaldo_e5.default_acl d, aclexplode(d.defaclacl) a
    WHERE d.defaclobjtype IN ('r', 'S') AND a.grantee::regrole::text IN ('anon', 'authenticated')
  LOOP
    BEGIN
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %s IN SCHEMA public GRANT %s ON %s TO %s',
        r.rol, r.privilege_type, CASE WHEN r.defaclobjtype = 'S' THEN 'SEQUENCES' ELSE 'TABLES' END, r.gr);
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE WARNING 'Rollback E5: no se pudieron devolver los default privileges de % (tampoco se habían podido quitar).', r.rol;
    END;
  END LOOP;
END $$;

COMMIT;

-- Verificación: 0 filas (permisos de anon/authenticated hoy = foto, en los
-- objetos que siguen existiendo; se compara privilegio por privilegio porque
-- el orden dentro de relacl puede cambiar)
--   WITH antes AS (
--     SELECT o.relname, a.grantee, a.privilege_type FROM respaldo_e5.acl_objetos o, aclexplode(o.relacl) a
--     WHERE a.grantee::regrole::text IN ('anon','authenticated')
--       AND to_regclass(format('public.%I', o.relname)) IS NOT NULL),
--   hoy AS (
--     SELECT c.relname, a.grantee, a.privilege_type FROM pg_class c, aclexplode(c.relacl) a
--     WHERE c.relnamespace = 'public'::regnamespace AND a.grantee::regrole::text IN ('anon','authenticated')
--       AND c.relname IN (SELECT relname FROM respaldo_e5.acl_objetos))
--   (SELECT * FROM antes EXCEPT SELECT * FROM hoy) UNION ALL (SELECT * FROM hoy EXCEPT SELECT * FROM antes);
--
-- Cuando ya no haga falta volver atrás: DROP SCHEMA respaldo_e5 CASCADE;
