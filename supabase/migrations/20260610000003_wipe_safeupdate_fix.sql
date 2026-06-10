-- ============================================================
-- TEMPORAL — fix del wipe de QA (2026-06-10): la instancia tiene activada la
-- proteccion pg-safeupdate ("DELETE requires a WHERE clause"), que rechaza los
-- DELETE sin WHERE incluso dentro de funciones. Se agrega WHERE true a todos
-- los DELETE (mismo comportamiento, satisface la proteccion) y se blinda el
-- DELETE de la tabla legacy `firmas` por si ya fue dropeada.
--
-- Mismo contrato que 20260610000002: borra SOLO datos transaccionales de
-- prueba; conserva TODAS las cuentas y la configuracion.
-- IMPORTANTE: eliminar junto con el modulo admin-tools antes de produccion.
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
  DELETE FROM evidencias_firma WHERE true;            GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{evidencias_firma}', to_jsonb(v_count));
  DELETE FROM codigos_otp WHERE true;                 GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{codigos_otp}', to_jsonb(v_count));
  DELETE FROM solicitudes_firma WHERE true;           GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{solicitudes_firma}', to_jsonb(v_count));
  DELETE FROM contrato_versiones WHERE true;          GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{contrato_versiones}', to_jsonb(v_count));
  DELETE FROM contrato_archivos WHERE true;           GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{contrato_archivos}', to_jsonb(v_count));
  DELETE FROM contrato_historial_estados WHERE true;  GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{contrato_historial_estados}', to_jsonb(v_count));
  DELETE FROM contrato_accesos_firmado WHERE true;    GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{contrato_accesos_firmado}', to_jsonb(v_count));
  DELETE FROM contratos WHERE true;                   GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{contratos}', to_jsonb(v_count));

  -- Estudios
  DELETE FROM estudios_documentos_soporte WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{estudios_documentos_soporte}', to_jsonb(v_count));
  DELETE FROM estudios_certificados WHERE true;       GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{estudios_certificados}', to_jsonb(v_count));
  DELETE FROM expediente_coarrendatarios WHERE true;  GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{expediente_coarrendatarios}', to_jsonb(v_count));
  DELETE FROM estudios WHERE true;                    GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{estudios}', to_jsonb(v_count));

  -- Autorizaciones habeas data
  DELETE FROM autorizaciones_habeas_data WHERE true;  GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{autorizaciones_habeas_data}', to_jsonb(v_count));
  DELETE FROM autorizacion_otps WHERE true;           GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{autorizacion_otps}', to_jsonb(v_count));

  -- Créditos de estudios (lotes/compras; el catálogo de paquetes se conserva)
  DELETE FROM movimientos_creditos_estudios WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{movimientos_creditos_estudios}', to_jsonb(v_count));
  DELETE FROM lotes_creditos_estudios WHERE true;       GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{lotes_creditos_estudios}', to_jsonb(v_count));
  DELETE FROM compras_creditos_estudios WHERE true;     GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{compras_creditos_estudios}', to_jsonb(v_count));

  -- Pagos / facturación
  DELETE FROM eventos_pago WHERE true;                GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{eventos_pago}', to_jsonb(v_count));
  DELETE FROM pagos WHERE true;                       GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{pagos}', to_jsonb(v_count));
  DELETE FROM facturas WHERE true;                    GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{facturas}', to_jsonb(v_count));
  DELETE FROM pagos_no_conciliados WHERE true;        GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{pagos_no_conciliados}', to_jsonb(v_count));

  -- Documentos / actividad del expediente
  DELETE FROM documentos WHERE true;                  GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{documentos}', to_jsonb(v_count));
  DELETE FROM comentarios WHERE true;                 GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{comentarios}', to_jsonb(v_count));
  DELETE FROM eventos_timeline WHERE true;            GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{eventos_timeline}', to_jsonb(v_count));
  DELETE FROM notificaciones WHERE true;              GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{notificaciones}', to_jsonb(v_count));
  DELETE FROM citas WHERE true;                       GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{citas}', to_jsonb(v_count));

  -- Moras y soporte
  DELETE FROM moras_mensajes WHERE true;              GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{moras_mensajes}', to_jsonb(v_count));
  DELETE FROM moras_tickets WHERE true;               GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{moras_tickets}', to_jsonb(v_count));
  DELETE FROM tickets_soporte WHERE true;             GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{tickets_soporte}', to_jsonb(v_count));

  -- Expedientes / solicitantes / inmuebles
  DELETE FROM expedientes WHERE true;                 GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{expedientes}', to_jsonb(v_count));
  DELETE FROM expediente_yearly_seq WHERE true;       GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{expediente_yearly_seq}', to_jsonb(v_count));
  DELETE FROM solicitantes WHERE true;                GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{solicitantes}', to_jsonb(v_count));
  DELETE FROM vitrina_interacciones WHERE true;       GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{vitrina_interacciones}', to_jsonb(v_count));
  DELETE FROM cambios_inmuebles WHERE true;           GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{cambios_inmuebles}', to_jsonb(v_count));
  DELETE FROM fotos_inmueble WHERE true;              GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{fotos_inmueble}', to_jsonb(v_count));
  DELETE FROM inmuebles WHERE true;                   GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{inmuebles}', to_jsonb(v_count));

  -- Tabla legacy `firmas` (si ya fue dropeada, seguimos sin error).
  BEGIN
    EXECUTE 'DELETE FROM firmas WHERE true';
  EXCEPTION WHEN undefined_table THEN
    NULL;
  END;

  -- Bitácora — limpia el log operativo.
  DELETE FROM bitacora WHERE true;                    GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{bitacora}', to_jsonb(v_count));

  -- NO se borra ninguna cuenta (perfiles / auth.users) ni los datos ligados a
  -- la cuenta: disponibilidad_propietario, email_verification_tokens,
  -- password_reset_tokens, terminos_aceptaciones, documentos_legales_inmobiliaria.
  v_counts := jsonb_set(v_counts, '{cuentas_preservadas}', to_jsonb((SELECT count(*) FROM perfiles)));

  RETURN v_counts;
END;
$$;

COMMENT ON FUNCTION fn_wipe_test_data() IS
  'TEMPORAL: borra datos transaccionales de prueba CONSERVANDO todas las cuentas (WHERE true por pg-safeupdate). ELIMINAR antes de produccion.';

REVOKE EXECUTE ON FUNCTION fn_wipe_test_data() FROM PUBLIC;
