-- ============================================================
-- RLS: copia EXACTA de producción (estado leído el 2026-09-28).
--
-- Producción tiene RLS en las 65 tablas de `public` gracias a un event trigger
-- (`ensure_rls` → `rls_auto_enable()`) que nunca estuvo en el repo, y 36
-- políticas por `get_my_role()` que tampoco. Montado solo desde el repo
-- (staging), ~32 tablas quedaban sin RLS y con GRANT a anon.
--
-- IDEMPOTENTE: en producción no cambia nada. Todo se crea SOLO si falta
-- (función, event trigger, política) y el ENABLE solo toca tablas sin RLS.
-- No endurece nada: eso va aparte (supabase/propuestas-endurecimiento/).
--
-- Los cuerpos de get_my_role() y rls_auto_enable() son los de producción
-- (pg_get_functiondef, 2026-09-28). En producción ya existen y no se tocan.
--
-- Verificación (debe dar 0 filas / los mismos números que antes):
--   SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--   WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relrowsecurity;
--   SELECT count(*) FROM pg_policies WHERE schemaname = 'public';  -- 38
--   SELECT evtname, evtenabled FROM pg_event_trigger WHERE evtname = 'ensure_rls';
-- ============================================================

-- 1. get_my_role(): rol de quien llama (lo usan las políticas de abajo).
--    Cuerpo idéntico a pg_get_functiondef de producción (2026-09-28).
DO $$
BEGIN
  IF to_regprocedure('public.get_my_role()') IS NULL THEN
    CREATE FUNCTION public.get_my_role()
     RETURNS rol_usuario
     LANGUAGE sql
     STABLE SECURITY DEFINER
    AS $function$
      SELECT rol FROM public.perfiles WHERE id = auth.uid();
    $function$;
  END IF;
END $$;

-- 2. rls_auto_enable(): activa RLS en toda tabla nueva de public.
--    Cuerpo idéntico a pg_get_functiondef de producción (2026-09-28).
DO $$
BEGIN
  IF to_regprocedure('public.rls_auto_enable()') IS NULL THEN
    CREATE FUNCTION public.rls_auto_enable()
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
      LOOP
         IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
          BEGIN
            EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
            RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
          EXCEPTION
            WHEN OTHERS THEN
              RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
          END;
         ELSE
            RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
         END IF;
      END LOOP;
    END;
    $function$;
  END IF;
END $$;

-- 3. Event trigger (requiere el rol postgres de Supabase).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = 'ensure_rls') THEN
    CREATE EVENT TRIGGER ensure_rls ON ddl_command_end
      WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      EXECUTE FUNCTION public.rls_auto_enable();
  END IF;
END $$;

-- 4. RLS en todas las tablas de public que todavía no lo tengan
--    (las creadas antes del event trigger). En producción: ninguna.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
  END LOOP;
END $$;

-- 5. Políticas de producción que no están en otras migraciones (las 2 de
--    notificaciones ya viven en 20260429000003). Solo se crean si faltan.
DO $$
DECLARE
  p record;
  interno  text := $x$(get_my_role() = ANY (ARRAY['administrador'::rol_usuario, 'operador_analista'::rol_usuario, 'gerencia_consulta'::rol_usuario]))$x$;
  escribe  text := $x$(get_my_role() = ANY (ARRAY['administrador'::rol_usuario, 'operador_analista'::rol_usuario]))$x$;
  admin    text := $x$(get_my_role() = 'administrador'::rol_usuario)$x$;
BEGIN
  FOR p IN
    SELECT * FROM (VALUES
      -- tabla, política, comando, USING, WITH CHECK
      ('autorizaciones_habeas_data', 'autorizaciones_habeas_insert', 'INSERT', NULL, escribe),
      ('autorizaciones_habeas_data', 'autorizaciones_habeas_select', 'SELECT', interno, NULL),
      ('autorizaciones_habeas_data', 'autorizaciones_habeas_update', 'UPDATE', escribe, escribe),
      ('bitacora', 'bitacora_select', 'SELECT',
        $x$(get_my_role() = ANY (ARRAY['administrador'::rol_usuario, 'gerencia_consulta'::rol_usuario]))$x$, NULL),
      ('comentarios', 'comentarios_insert', 'INSERT', NULL,
        $x$((get_my_role() = ANY (ARRAY['administrador'::rol_usuario, 'operador_analista'::rol_usuario, 'gerencia_consulta'::rol_usuario])) AND (usuario_id = auth.uid()))$x$),
      ('comentarios', 'comentarios_select', 'SELECT', interno, NULL),
      ('contratos', 'contratos_insert', 'INSERT', NULL, escribe),
      ('contratos', 'contratos_select', 'SELECT', interno, NULL),
      ('contratos', 'contratos_update', 'UPDATE', escribe, escribe),
      ('documentos', 'documentos_delete', 'DELETE', escribe, NULL),
      ('documentos', 'documentos_insert', 'INSERT', NULL, escribe),
      ('documentos', 'documentos_select', 'SELECT', interno, NULL),
      ('documentos', 'documentos_update', 'UPDATE', escribe, escribe),
      ('estudios', 'estudios_insert', 'INSERT', NULL, escribe),
      ('estudios', 'estudios_select', 'SELECT', interno, NULL),
      ('estudios', 'estudios_update', 'UPDATE', escribe, escribe),
      ('eventos_timeline', 'eventos_timeline_insert', 'INSERT', NULL, escribe),
      ('eventos_timeline', 'eventos_timeline_select', 'SELECT', interno, NULL),
      ('expedientes', 'expedientes_insert', 'INSERT', NULL, escribe),
      ('expedientes', 'expedientes_select_internal', 'SELECT', interno, NULL),
      ('expedientes', 'expedientes_select_owner', 'SELECT',
        $x$((get_my_role() = ANY (ARRAY['propietario'::rol_usuario, 'inmobiliaria'::rol_usuario])) AND (inmueble_id IN (SELECT inmuebles.id FROM inmuebles WHERE (inmuebles.propietario_id = auth.uid()))))$x$, NULL),
      ('expedientes', 'expedientes_update', 'UPDATE',
        $x$((get_my_role() = ANY (ARRAY['administrador'::rol_usuario, 'operador_analista'::rol_usuario])) OR (analista_id = auth.uid()))$x$,
        $x$((get_my_role() = ANY (ARRAY['administrador'::rol_usuario, 'operador_analista'::rol_usuario])) OR (analista_id = auth.uid()))$x$),
      ('facturas', 'facturas_insert', 'INSERT', NULL, escribe),
      ('facturas', 'facturas_select', 'SELECT', interno, NULL),
      ('facturas', 'facturas_update', 'UPDATE', escribe, escribe),
      ('inmuebles', 'inmuebles_insert', 'INSERT', NULL, escribe),
      ('inmuebles', 'inmuebles_select_internal', 'SELECT', interno, NULL),
      ('inmuebles', 'inmuebles_select_owner', 'SELECT',
        $x$((get_my_role() = ANY (ARRAY['propietario'::rol_usuario, 'inmobiliaria'::rol_usuario])) AND (propietario_id = auth.uid()))$x$, NULL),
      ('inmuebles', 'inmuebles_select_vitrina', 'SELECT', $x$(visible_vitrina = true)$x$, NULL),
      ('inmuebles', 'inmuebles_update', 'UPDATE', escribe, escribe),
      ('plantillas_contrato', 'plantillas_contrato_insert', 'INSERT', NULL, admin),
      ('plantillas_contrato', 'plantillas_contrato_select', 'SELECT', interno, NULL),
      ('plantillas_contrato', 'plantillas_contrato_update', 'UPDATE', admin, admin),
      ('solicitantes', 'solicitantes_insert', 'INSERT', NULL, escribe),
      ('solicitantes', 'solicitantes_select', 'SELECT', interno, NULL),
      ('solicitantes', 'solicitantes_update', 'UPDATE', escribe, escribe)
    ) AS v(tabla, nombre, cmd, usando, chequeo)
  LOOP
    IF to_regclass('public.' || p.tabla) IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_policies
                       WHERE schemaname = 'public' AND tablename = p.tabla AND policyname = p.nombre) THEN
      EXECUTE format('CREATE POLICY %I ON public.%I AS PERMISSIVE FOR %s TO authenticated%s%s',
        p.nombre, p.tabla, p.cmd,
        CASE WHEN p.usando  IS NOT NULL THEN ' USING ('      || p.usando  || ')' ELSE '' END,
        CASE WHEN p.chequeo IS NOT NULL THEN ' WITH CHECK (' || p.chequeo || ')' ELSE '' END);
    END IF;
  END LOOP;
END $$;
