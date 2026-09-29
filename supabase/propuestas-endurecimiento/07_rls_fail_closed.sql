-- E7 · rls_auto_enable FAIL-CLOSED + chequeo de tablas sin RLS.
-- Hoy (prod): si no puede activar RLS, lo anota en el log y DEJA crear la
-- tabla sin RLS. Con esto, el CREATE TABLE en public aborta.
-- Riesgo de romper: BAJO. Solo afecta a CREATE TABLE / CREATE TABLE AS /
-- SELECT INTO en public; si algo falla, la migración que crea la tabla falla
-- entera (es lo que se busca).
--
-- Casos a saber (probarlos en staging antes de producción):
--   1. Extensiones: pg_event_trigger_ddl_commands() SÍ devuelve las tablas que
--      crea un CREATE EXTENSION (con in_extension = true). Se saltan con
--      `AND NOT in_extension`: una extensión instalada en public (p. ej. postgis
--      crea spatial_ref_sys) no se aborta; esa tabla queda sin RLS y el chequeo
--      de abajo la señala. Mejor: instalar extensiones en el esquema extensions.
--   2. Tabla de otro dueño: el ALTER corre como el dueño de esta función
--      (postgres, SECURITY DEFINER) y ENABLE ROW LEVEL SECURITY exige ser dueño
--      de la tabla. Si otro rol del que postgres no es miembro (supabase_admin,
--      el rol de una integración) crea una tabla en public, su CREATE TABLE se
--      aborta. Hoy (versión de producción) ese caso solo deja un LOG y la tabla
--      nace sin RLS; con E7 falla, que es lo buscado, pero hay que saberlo.
--   3. CREATE TABLE normal de postgres (las migraciones): RLS activado, sigue.
-- Rollback: recrear el cuerpo de la sección 2 de 20261001000015_rls_copia_de_produccion.sql
-- con CREATE OR REPLACE.

CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
      AND schema_name = 'public'
      AND NOT in_extension  -- caso 1 de arriba
  LOOP
    -- Sin EXCEPTION: si el ALTER falla, el error sube y aborta el CREATE TABLE.
    EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = cmd.objid) THEN
      RAISE EXCEPTION 'rls_auto_enable: % quedó sin RLS; se aborta el CREATE TABLE', cmd.object_identity;
    END IF;
    RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
  END LOOP;
END;
$function$;

-- Chequeo (también sirve suelto después de cualquier migración o en staging):
-- falla si hay tablas en public sin RLS o si el event trigger no está activo.
DO $$
DECLARE
  sin_rls text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO sin_rls
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity;
  IF sin_rls IS NOT NULL THEN
    RAISE EXCEPTION 'Tablas en public sin RLS: %', sin_rls;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = 'ensure_rls' AND evtenabled <> 'D') THEN
    RAISE EXCEPTION 'El event trigger ensure_rls no existe o está deshabilitado';
  END IF;
END $$;
