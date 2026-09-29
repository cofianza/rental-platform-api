-- ROLLBACK de E3 · vuelve a crear las políticas de escritura directa que
-- quitó 03_quitar_escrituras_directas.sql, con la definición de producción
-- (sección 5 de 20261001000015 y 20260429000003_notificaciones.sql:42).
-- Idempotente: solo crea las que falten.
DO $$
DECLARE
  p record;
  escribe  text := $x$(get_my_role() = ANY (ARRAY['administrador'::rol_usuario, 'operador_analista'::rol_usuario]))$x$;
  admin    text := $x$(get_my_role() = 'administrador'::rol_usuario)$x$;
BEGIN
  FOR p IN
    SELECT * FROM (VALUES
      -- tabla, política, comando, USING, WITH CHECK
      ('autorizaciones_habeas_data', 'autorizaciones_habeas_insert', 'INSERT', NULL, escribe),
      ('autorizaciones_habeas_data', 'autorizaciones_habeas_update', 'UPDATE', escribe, escribe),
      ('comentarios', 'comentarios_insert', 'INSERT', NULL,
        $x$((get_my_role() = ANY (ARRAY['administrador'::rol_usuario, 'operador_analista'::rol_usuario, 'gerencia_consulta'::rol_usuario])) AND (usuario_id = auth.uid()))$x$),
      ('contratos', 'contratos_insert', 'INSERT', NULL, escribe),
      ('contratos', 'contratos_update', 'UPDATE', escribe, escribe),
      ('documentos', 'documentos_delete', 'DELETE', escribe, NULL),
      ('documentos', 'documentos_insert', 'INSERT', NULL, escribe),
      ('documentos', 'documentos_update', 'UPDATE', escribe, escribe),
      ('estudios', 'estudios_insert', 'INSERT', NULL, escribe),
      ('estudios', 'estudios_update', 'UPDATE', escribe, escribe),
      ('eventos_timeline', 'eventos_timeline_insert', 'INSERT', NULL, escribe),
      ('expedientes', 'expedientes_insert', 'INSERT', NULL, escribe),
      ('expedientes', 'expedientes_update', 'UPDATE',
        $x$((get_my_role() = ANY (ARRAY['administrador'::rol_usuario, 'operador_analista'::rol_usuario])) OR (analista_id = auth.uid()))$x$,
        $x$((get_my_role() = ANY (ARRAY['administrador'::rol_usuario, 'operador_analista'::rol_usuario])) OR (analista_id = auth.uid()))$x$),
      ('facturas', 'facturas_insert', 'INSERT', NULL, escribe),
      ('facturas', 'facturas_update', 'UPDATE', escribe, escribe),
      ('inmuebles', 'inmuebles_insert', 'INSERT', NULL, escribe),
      ('inmuebles', 'inmuebles_update', 'UPDATE', escribe, escribe),
      ('plantillas_contrato', 'plantillas_contrato_insert', 'INSERT', NULL, admin),
      ('plantillas_contrato', 'plantillas_contrato_update', 'UPDATE', admin, admin),
      ('solicitantes', 'solicitantes_insert', 'INSERT', NULL, escribe),
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

  -- Notificaciones: como en 20260429000003 (sin TO → {public}).
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                 AND tablename = 'notificaciones' AND policyname = 'users_update_own_notificaciones') THEN
    CREATE POLICY users_update_own_notificaciones ON public.notificaciones
      FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

-- Verificación: 22 (las 21 de arriba + users_update_own_notificaciones)
--   SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND cmd <> 'SELECT';
