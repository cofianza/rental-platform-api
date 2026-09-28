-- E5 · Segunda defensa: anon y authenticated sin permisos sobre las tablas,
-- aunque alguien apague RLS. Solo queda SELECT en notificaciones para Realtime.
-- Riesgo de romper: MEDIO (toca todo public y los defaults de tablas futuras).
-- Probar primero en staging: login, campanita en vivo, vitrina pública, fotos.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
GRANT SELECT ON public.notificaciones TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
-- Verificación: solo notificaciones/SELECT/authenticated
--   SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
--   WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated');
-- Rollback: GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated; (y los defaults)
