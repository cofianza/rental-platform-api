-- E4 · Sin lecturas directas por PostgREST salvo la de notificaciones
-- (Realtime la necesita). Cierra la vitrina con todas las columnas para
-- cualquier cuenta (inmuebles_select_vitrina) y las lecturas internas.
-- Riesgo de romper: BAJO. Probar después la campanita de notificaciones.
DROP POLICY IF EXISTS autorizaciones_habeas_select ON public.autorizaciones_habeas_data;
DROP POLICY IF EXISTS bitacora_select ON public.bitacora;
DROP POLICY IF EXISTS comentarios_select ON public.comentarios;
DROP POLICY IF EXISTS contratos_select ON public.contratos;
DROP POLICY IF EXISTS documentos_select ON public.documentos;
DROP POLICY IF EXISTS estudios_select ON public.estudios;
DROP POLICY IF EXISTS eventos_timeline_select ON public.eventos_timeline;
DROP POLICY IF EXISTS expedientes_select_internal ON public.expedientes;
DROP POLICY IF EXISTS expedientes_select_owner ON public.expedientes;
DROP POLICY IF EXISTS facturas_select ON public.facturas;
DROP POLICY IF EXISTS inmuebles_select_internal ON public.inmuebles;
DROP POLICY IF EXISTS inmuebles_select_owner ON public.inmuebles;
DROP POLICY IF EXISTS inmuebles_select_vitrina ON public.inmuebles;
DROP POLICY IF EXISTS plantillas_contrato_select ON public.plantillas_contrato;
DROP POLICY IF EXISTS solicitantes_select ON public.solicitantes;
-- Notificaciones: solo con sesión (hoy {public} incluye anon, aunque no ve nada).
ALTER POLICY users_read_own_notificaciones ON public.notificaciones TO authenticated;
-- Verificación: 1 fila (users_read_own_notificaciones, {authenticated})
--   SELECT tablename, policyname, roles FROM pg_policies WHERE schemaname = 'public';
