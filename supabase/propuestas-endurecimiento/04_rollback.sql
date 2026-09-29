-- ROLLBACK de E4 · vuelve a crear las políticas de lectura directa que quitó
-- 04_quitar_lecturas_directas.sql (definición de producción, sección 5 de
-- 20261001000015) y devuelve users_read_own_notificaciones a {public}, como
-- estaba en 20260429000003. Idempotente: solo crea las que falten.
--
-- inmuebles_select_vitrina NO se recrea: se quitó a propósito el 2026-09-28
-- (migración 20261001000019) porque dejaba leer todas las columnas de los
-- inmuebles publicados a cualquier cuenta con sesión.
DO $$
DECLARE
  p record;
  interno  text := $x$(get_my_role() = ANY (ARRAY['administrador'::rol_usuario, 'operador_analista'::rol_usuario, 'gerencia_consulta'::rol_usuario]))$x$;
BEGIN
  FOR p IN
    SELECT * FROM (VALUES
      -- tabla, política, USING
      ('autorizaciones_habeas_data', 'autorizaciones_habeas_select', interno),
      ('bitacora', 'bitacora_select',
        $x$(get_my_role() = ANY (ARRAY['administrador'::rol_usuario, 'gerencia_consulta'::rol_usuario]))$x$),
      ('comentarios', 'comentarios_select', interno),
      ('contratos', 'contratos_select', interno),
      ('documentos', 'documentos_select', interno),
      ('estudios', 'estudios_select', interno),
      ('eventos_timeline', 'eventos_timeline_select', interno),
      ('expedientes', 'expedientes_select_internal', interno),
      ('expedientes', 'expedientes_select_owner',
        $x$((get_my_role() = ANY (ARRAY['propietario'::rol_usuario, 'inmobiliaria'::rol_usuario])) AND (inmueble_id IN (SELECT inmuebles.id FROM inmuebles WHERE (inmuebles.propietario_id = auth.uid()))))$x$),
      ('facturas', 'facturas_select', interno),
      ('inmuebles', 'inmuebles_select_internal', interno),
      ('inmuebles', 'inmuebles_select_owner',
        $x$((get_my_role() = ANY (ARRAY['propietario'::rol_usuario, 'inmobiliaria'::rol_usuario])) AND (propietario_id = auth.uid()))$x$),
      ('plantillas_contrato', 'plantillas_contrato_select', interno),
      ('solicitantes', 'solicitantes_select', interno)
    ) AS v(tabla, nombre, usando)
  LOOP
    IF to_regclass('public.' || p.tabla) IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_policies
                       WHERE schemaname = 'public' AND tablename = p.tabla AND policyname = p.nombre) THEN
      EXECUTE format('CREATE POLICY %I ON public.%I AS PERMISSIVE FOR SELECT TO authenticated USING (%s)',
        p.nombre, p.tabla, p.usando);
    END IF;
  END LOOP;
END $$;

ALTER POLICY users_read_own_notificaciones ON public.notificaciones TO public;

-- Verificación: 15 (las 14 de arriba + users_read_own_notificaciones con {public})
--   SELECT tablename, policyname, roles FROM pg_policies WHERE schemaname = 'public' AND cmd = 'SELECT';
