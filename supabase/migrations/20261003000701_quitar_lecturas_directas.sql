-- ============================================================
-- E4 (propuestas de endurecimiento, 2026-09-28) aplicada en producción el
-- 2026-09-29. Copia de supabase/propuestas-endurecimiento/04_quitar_lecturas_directas.sql.
-- Rollback: supabase/propuestas-endurecimiento/04_rollback.sql.
-- ============================================================
-- E4 · Sin lecturas directas por PostgREST salvo la de notificaciones
-- (Realtime la necesita). Cierra la vitrina con todas las columnas para
-- cualquier cuenta (inmuebles_select_vitrina) y las lecturas internas.
-- Riesgo de romper: BAJO. Probar después la campanita de notificaciones.
-- Orden: después de 03 (no depende de ella para correr, pero así el cierre
-- queda completo: sin 03 siguen vivas las políticas de escritura).
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
-- inmuebles_select_vitrina: YA APLICADO el 2026-09-28 (migración 20261001000019).
DROP POLICY IF EXISTS inmuebles_select_vitrina ON public.inmuebles;
DROP POLICY IF EXISTS plantillas_contrato_select ON public.plantillas_contrato;
DROP POLICY IF EXISTS solicitantes_select ON public.solicitantes;
-- Notificaciones: solo con sesión (hoy {public} incluye anon, aunque no ve nada).
ALTER POLICY users_read_own_notificaciones ON public.notificaciones TO authenticated;
-- Verificación: 1 fila (users_read_own_notificaciones, {authenticated}),
-- haya corrido 03 o no (solo cuenta las de lectura):
--   SELECT tablename, policyname, roles FROM pg_policies WHERE schemaname = 'public' AND cmd = 'SELECT';
-- Con 03 también aplicada, sin el filtro de cmd debe dar la misma única fila.
-- Rollback: 04_rollback.sql (las 14 de lectura de la sección 5 de la 015 y
--   users_read_own_notificaciones de vuelta a {public}). inmuebles_select_vitrina
--   NO vuelve: se quitó a propósito (migración 20261001000019).
