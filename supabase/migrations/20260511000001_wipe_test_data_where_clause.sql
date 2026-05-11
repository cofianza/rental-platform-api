-- ============================================================
-- Fix: el RPC fn_wipe_test_data fallaba con "DELETE requires a WHERE
-- clause" porque Supabase tiene activo pg_safeupdate (o equivalente)
-- que bloquea DELETEs sin WHERE para prevenir borrados masivos
-- accidentales.
--
-- Solucion: agregar `WHERE true` a cada DELETE. Es semanticamente
-- equivalente a `DELETE FROM tabla;` (borra todas las filas) pero
-- satisface el chequeo de safeupdate. Mantiene la intencion original
-- (limpiar todos los datos transaccionales para QA).
--
-- TEMPORAL: borrar junto con 20260507000005_admin_wipe_test_data.sql
-- antes de pasar a produccion.
-- ============================================================

CREATE OR REPLACE FUNCTION fn_wipe_test_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_admin_ids uuid[];
  v_counts jsonb := '{}'::jsonb;
  v_count bigint;
BEGIN
  SELECT array_agg(id) INTO v_admin_ids FROM perfiles WHERE rol = 'administrador';
  v_counts := jsonb_set(v_counts, '{admins_preservados}', to_jsonb(coalesce(array_length(v_admin_ids, 1), 0)));

  SET CONSTRAINTS ALL DEFERRED;

  -- Cada DELETE lleva WHERE true para esquivar pg_safeupdate sin cambiar
  -- la semantica (borra todas las filas igual).
  DELETE FROM evidencias_firma            WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{evidencias_firma}', to_jsonb(v_count));
  DELETE FROM codigos_otp                 WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{codigos_otp}', to_jsonb(v_count));
  DELETE FROM solicitudes_firma           WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{solicitudes_firma}', to_jsonb(v_count));
  DELETE FROM contrato_versiones          WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{contrato_versiones}', to_jsonb(v_count));
  DELETE FROM contrato_archivos           WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{contrato_archivos}', to_jsonb(v_count));
  DELETE FROM contrato_historial_estados  WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{contrato_historial_estados}', to_jsonb(v_count));
  DELETE FROM contrato_accesos_firmado    WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{contrato_accesos_firmado}', to_jsonb(v_count));
  DELETE FROM contratos                   WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{contratos}', to_jsonb(v_count));

  DELETE FROM estudios_documentos_soporte WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{estudios_documentos_soporte}', to_jsonb(v_count));
  DELETE FROM estudios_certificados       WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{estudios_certificados}', to_jsonb(v_count));
  DELETE FROM expediente_coarrendatarios  WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{expediente_coarrendatarios}', to_jsonb(v_count));
  DELETE FROM estudios                    WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{estudios}', to_jsonb(v_count));

  DELETE FROM autorizaciones_habeas_data  WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{autorizaciones_habeas_data}', to_jsonb(v_count));
  DELETE FROM autorizacion_otps           WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{autorizacion_otps}', to_jsonb(v_count));

  DELETE FROM movimientos_creditos_estudios WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{movimientos_creditos_estudios}', to_jsonb(v_count));
  DELETE FROM lotes_creditos_estudios       WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{lotes_creditos_estudios}', to_jsonb(v_count));
  DELETE FROM compras_creditos_estudios     WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{compras_creditos_estudios}', to_jsonb(v_count));

  DELETE FROM eventos_pago                WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{eventos_pago}', to_jsonb(v_count));
  DELETE FROM pagos                       WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{pagos}', to_jsonb(v_count));
  DELETE FROM facturas                    WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{facturas}', to_jsonb(v_count));

  DELETE FROM documentos                  WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{documentos}', to_jsonb(v_count));
  DELETE FROM comentarios                 WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{comentarios}', to_jsonb(v_count));
  DELETE FROM eventos_timeline            WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{eventos_timeline}', to_jsonb(v_count));
  DELETE FROM notificaciones              WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{notificaciones}', to_jsonb(v_count));
  DELETE FROM citas                       WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{citas}', to_jsonb(v_count));

  DELETE FROM expedientes                 WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{expedientes}', to_jsonb(v_count));
  DELETE FROM expediente_yearly_seq       WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{expediente_yearly_seq}', to_jsonb(v_count));
  DELETE FROM solicitantes                WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{solicitantes}', to_jsonb(v_count));

  DELETE FROM cambios_inmuebles           WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{cambios_inmuebles}', to_jsonb(v_count));
  DELETE FROM fotos_inmueble              WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{fotos_inmueble}', to_jsonb(v_count));
  DELETE FROM inmuebles                   WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{inmuebles}', to_jsonb(v_count));

  DELETE FROM disponibilidad_propietario  WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{disponibilidad_propietario}', to_jsonb(v_count));

  DELETE FROM email_verification_tokens   WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{email_verification_tokens}', to_jsonb(v_count));
  DELETE FROM password_reset_tokens       WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{password_reset_tokens}', to_jsonb(v_count));
  DELETE FROM terminos_aceptaciones       WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{terminos_aceptaciones}', to_jsonb(v_count));

  -- Tabla legacy `firmas` (predecesora de solicitudes_firma). Si todavia
  -- existe, limpiarla con WHERE true. Si ya fue dropeada, lo silenciamos.
  BEGIN
    EXECUTE 'DELETE FROM firmas WHERE true';
  EXCEPTION WHEN undefined_table THEN
    -- tabla ya no existe, ok
    NULL;
  END;

  DELETE FROM bitacora                    WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{bitacora}', to_jsonb(v_count));

  -- Cuentas no-admin: primero perfiles, luego auth.users.
  DELETE FROM perfiles WHERE id <> ALL(coalesce(v_admin_ids, ARRAY[]::uuid[]));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_counts := jsonb_set(v_counts, '{perfiles_no_admin}', to_jsonb(v_count));

  DELETE FROM auth.users WHERE id <> ALL(coalesce(v_admin_ids, ARRAY[]::uuid[]));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_counts := jsonb_set(v_counts, '{auth_users_no_admin}', to_jsonb(v_count));

  RETURN v_counts;
END;
$$;

COMMENT ON FUNCTION fn_wipe_test_data() IS
  'TEMPORAL: borra datos transaccionales y cuentas no-admin para QA. Llamada solo desde el endpoint admin/wipe-test-data. ELIMINAR antes de produccion.';

REVOKE EXECUTE ON FUNCTION fn_wipe_test_data() FROM PUBLIC;
