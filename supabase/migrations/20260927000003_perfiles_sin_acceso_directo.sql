-- ============================================================
-- Seguridad (CRÍTICO): `perfiles` se podía leer sin sesión y cualquier
-- usuario con sesión podía cambiarse el rol.
--
-- Lo que había (políticas creadas a mano, no están en las migraciones):
--   - "Allow public read on perfiles" (SELECT a public, USING true): con la
--     llave anon, que es pública, cualquiera en internet lee TODOS los perfiles:
--     cédula, teléfono, dirección, NIT, representante legal y cuentas bancarias
--     de recaudo.
--   - perfiles_select (SELECT a authenticated, USING true): lo mismo con sesión.
--   - perfiles_update_own (UPDATE a authenticated, id = auth.uid()) + GRANT de
--     UPDATE en todas las columnas: un usuario recién registrado podía llamar a
--     /rest/v1/perfiles con su propio token y ponerse rol = 'administrador'. La
--     API toma el rol de esta tabla y las demás políticas usan get_my_role().
--   - perfiles_update_admin: un administrador escribiendo sin pasar por la API.
--   - bitacora_insert (INSERT a authenticated, WITH CHECK true): cualquiera con
--     sesión podía fabricar entradas de auditoría.
--
-- Nada legítimo usa esos caminos: la API lee y escribe con service_role (que no
-- los necesita), get_my_role() es SECURITY DEFINER y el buscador de propietarios
-- de la web ya va por la API (GET /users/buscar, mismo commit).
-- ============================================================

DROP POLICY IF EXISTS "Allow public read on perfiles" ON public.perfiles;
DROP POLICY IF EXISTS perfiles_select ON public.perfiles;
DROP POLICY IF EXISTS perfiles_update_own ON public.perfiles;
DROP POLICY IF EXISTS perfiles_update_admin ON public.perfiles;
REVOKE ALL ON TABLE public.perfiles FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS bitacora_insert ON public.bitacora;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.bitacora FROM PUBLIC, anon, authenticated;

-- Verificación (todo debe dar false y 0):
--   SELECT has_table_privilege('anon', 'public.perfiles', 'SELECT') AS anon_lee,
--          has_table_privilege('authenticated', 'public.perfiles', 'SELECT') AS auth_lee,
--          has_table_privilege('authenticated', 'public.perfiles', 'UPDATE') AS auth_escribe,
--          has_table_privilege('authenticated', 'public.bitacora', 'INSERT') AS auth_bitacora,
--          (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'perfiles') AS politicas_perfiles;
