-- ============================================================
-- E3 (propuestas de endurecimiento, 2026-09-28) aplicada en producción el
-- 2026-09-29. Copia de supabase/propuestas-endurecimiento/03_quitar_escrituras_directas.sql.
-- Rollback: supabase/propuestas-endurecimiento/03_rollback.sql.
-- ============================================================
-- E3 · Sin escrituras directas por PostgREST: todo INSERT/UPDATE/DELETE pasa
-- por la API (máquina de estados, bitácora, tenantScope).
-- Riesgo de romper: BAJO. La web no escribe en tablas (solo Realtime de
-- notificaciones, que es lectura); la API es service_role y no usa políticas.
DROP POLICY IF EXISTS autorizaciones_habeas_insert ON public.autorizaciones_habeas_data;
DROP POLICY IF EXISTS autorizaciones_habeas_update ON public.autorizaciones_habeas_data;
DROP POLICY IF EXISTS comentarios_insert ON public.comentarios;
DROP POLICY IF EXISTS contratos_insert ON public.contratos;
DROP POLICY IF EXISTS contratos_update ON public.contratos;
DROP POLICY IF EXISTS documentos_delete ON public.documentos;
DROP POLICY IF EXISTS documentos_insert ON public.documentos;
DROP POLICY IF EXISTS documentos_update ON public.documentos;
DROP POLICY IF EXISTS estudios_insert ON public.estudios;
DROP POLICY IF EXISTS estudios_update ON public.estudios;
DROP POLICY IF EXISTS eventos_timeline_insert ON public.eventos_timeline;
DROP POLICY IF EXISTS expedientes_insert ON public.expedientes;
DROP POLICY IF EXISTS expedientes_update ON public.expedientes;
DROP POLICY IF EXISTS facturas_insert ON public.facturas;
DROP POLICY IF EXISTS facturas_update ON public.facturas;
DROP POLICY IF EXISTS inmuebles_insert ON public.inmuebles;
DROP POLICY IF EXISTS inmuebles_update ON public.inmuebles;
DROP POLICY IF EXISTS plantillas_contrato_insert ON public.plantillas_contrato;
DROP POLICY IF EXISTS plantillas_contrato_update ON public.plantillas_contrato;
DROP POLICY IF EXISTS solicitantes_insert ON public.solicitantes;
DROP POLICY IF EXISTS solicitantes_update ON public.solicitantes;
-- La web marca leídas por la API, no por PostgREST.
DROP POLICY IF EXISTS users_update_own_notificaciones ON public.notificaciones;
-- Verificación: 0
--   SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND cmd <> 'SELECT';
-- Rollback: 03_rollback.sql (las 21 de escritura de la sección 5 de la 015
--   + users_update_own_notificaciones, que vive en 20260429000003).
