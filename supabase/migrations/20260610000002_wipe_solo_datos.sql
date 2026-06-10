-- ============================================================
-- TEMPORAL — redefine fn_wipe_test_data (pedido 2026-06-10):
-- el wipe de QA ahora CONSERVA TODAS LAS CUENTAS (de cualquier rol, con su
-- login) y borra únicamente los datos transaccionales de prueba. Antes
-- borraba también las cuentas no-administrador, lo que obligaba a recrear
-- usuarios reales del equipo entre rondas de QA.
--
-- Conserva:
--   - TODOS los perfiles + auth.users (cualquier rol).
--   - Datos ligados a la cuenta: disponibilidad_propietario, tokens de
--     verificación/reset, terminos_aceptaciones, documentos_legales_inmobiliaria.
--   - Datos de referencia/config: plantillas_contrato, configuracion_sistema,
--     paquetes_creditos_estudios, tipos_documento, configuracion_disponibilidad,
--     modalidades_fianza.
--
-- Borra (transaccional), además de lo que ya cubría la versión anterior:
--   moras_tickets, moras_mensajes, tickets_soporte, vitrina_interacciones,
--   pagos_no_conciliados (tablas creadas después del wipe original).
--
-- IMPORTANTE: borrar esta funcion (y el modulo admin-tools) antes de pasar
-- a produccion real.
-- ============================================================

CREATE OR REPLACE FUNCTION fn_wipe_test_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_counts jsonb := '{}'::jsonb;
  v_count bigint;
BEGIN
  -- Diferimos los FK constraints para no preocuparnos por el orden.
  SET CONSTRAINTS ALL DEFERRED;

  -- Firma / contratos
  DELETE FROM evidencias_firma;            GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{evidencias_firma}', to_jsonb(v_count));
  DELETE FROM codigos_otp;                 GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{codigos_otp}', to_jsonb(v_count));
  DELETE FROM solicitudes_firma;           GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{solicitudes_firma}', to_jsonb(v_count));
  DELETE FROM contrato_versiones;          GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{contrato_versiones}', to_jsonb(v_count));
  DELETE FROM contrato_archivos;           GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{contrato_archivos}', to_jsonb(v_count));
  DELETE FROM contrato_historial_estados;  GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{contrato_historial_estados}', to_jsonb(v_count));
  DELETE FROM contrato_accesos_firmado;    GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{contrato_accesos_firmado}', to_jsonb(v_count));
  DELETE FROM contratos;                   GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{contratos}', to_jsonb(v_count));

  -- Estudios
  DELETE FROM estudios_documentos_soporte; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{estudios_documentos_soporte}', to_jsonb(v_count));
  DELETE FROM estudios_certificados;       GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{estudios_certificados}', to_jsonb(v_count));
  DELETE FROM expediente_coarrendatarios;  GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{expediente_coarrendatarios}', to_jsonb(v_count));
  DELETE FROM estudios;                    GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{estudios}', to_jsonb(v_count));

  -- Autorizaciones habeas data
  DELETE FROM autorizaciones_habeas_data;  GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{autorizaciones_habeas_data}', to_jsonb(v_count));
  DELETE FROM autorizacion_otps;           GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{autorizacion_otps}', to_jsonb(v_count));

  -- Créditos de estudios (lotes/compras; el catálogo de paquetes se conserva)
  DELETE FROM movimientos_creditos_estudios; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{movimientos_creditos_estudios}', to_jsonb(v_count));
  DELETE FROM lotes_creditos_estudios;       GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{lotes_creditos_estudios}', to_jsonb(v_count));
  DELETE FROM compras_creditos_estudios;     GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{compras_creditos_estudios}', to_jsonb(v_count));

  -- Pagos / facturación
  DELETE FROM eventos_pago;                GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{eventos_pago}', to_jsonb(v_count));
  DELETE FROM pagos;                       GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{pagos}', to_jsonb(v_count));
  DELETE FROM facturas;                    GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{facturas}', to_jsonb(v_count));
  DELETE FROM pagos_no_conciliados;        GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{pagos_no_conciliados}', to_jsonb(v_count));

  -- Documentos / actividad del expediente
  DELETE FROM documentos;                  GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{documentos}', to_jsonb(v_count));
  DELETE FROM comentarios;                 GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{comentarios}', to_jsonb(v_count));
  DELETE FROM eventos_timeline;            GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{eventos_timeline}', to_jsonb(v_count));
  DELETE FROM notificaciones;              GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{notificaciones}', to_jsonb(v_count));
  DELETE FROM citas;                       GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{citas}', to_jsonb(v_count));

  -- Moras y soporte (tablas posteriores al wipe original)
  DELETE FROM moras_mensajes;              GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{moras_mensajes}', to_jsonb(v_count));
  DELETE FROM moras_tickets;               GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{moras_tickets}', to_jsonb(v_count));
  DELETE FROM tickets_soporte;             GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{tickets_soporte}', to_jsonb(v_count));

  -- Expedientes / solicitantes / inmuebles
  DELETE FROM expedientes;                 GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{expedientes}', to_jsonb(v_count));
  DELETE FROM expediente_yearly_seq;       GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{expediente_yearly_seq}', to_jsonb(v_count));
  DELETE FROM solicitantes;                GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{solicitantes}', to_jsonb(v_count));
  DELETE FROM vitrina_interacciones;       GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{vitrina_interacciones}', to_jsonb(v_count));
  DELETE FROM cambios_inmuebles;           GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{cambios_inmuebles}', to_jsonb(v_count));
  DELETE FROM fotos_inmueble;              GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{fotos_inmueble}', to_jsonb(v_count));
  DELETE FROM inmuebles;                   GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{inmuebles}', to_jsonb(v_count));

  -- Tabla legacy `firmas` (predecesora de solicitudes_firma), si existe aún.
  EXECUTE 'DELETE FROM firmas';

  -- Bitácora — limpia el log operativo.
  DELETE FROM bitacora;                    GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{bitacora}', to_jsonb(v_count));

  -- NOTA: a diferencia de la versión anterior, NO se borra ninguna cuenta
  -- (perfiles / auth.users) ni los datos ligados a la cuenta:
  -- disponibilidad_propietario, email_verification_tokens,
  -- password_reset_tokens, terminos_aceptaciones, documentos_legales_inmobiliaria.
  v_counts := jsonb_set(v_counts, '{cuentas_preservadas}', to_jsonb((SELECT count(*) FROM perfiles)));

  RETURN v_counts;
END;
$$;

COMMENT ON FUNCTION fn_wipe_test_data() IS
  'TEMPORAL: borra datos transaccionales de prueba CONSERVANDO todas las cuentas. Llamada solo desde el endpoint admin/wipe-test-data. ELIMINAR antes de produccion.';

REVOKE EXECUTE ON FUNCTION fn_wipe_test_data() FROM PUBLIC;
