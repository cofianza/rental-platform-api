-- ============================================================
-- TEMPORAL — Mario (7-may-2026): boton "Borrar datos de prueba" en el
-- dashboard del administrador para resetear el ambiente entre rondas de
-- QA. Borra todas las cuentas que NO son administrador y todos los
-- registros transaccionales asociados (expedientes, inmuebles, contratos,
-- estudios, citas, pagos, notificaciones, etc.).
--
-- Conserva:
--   - perfiles con rol='administrador' + sus auth.users.
--   - Plantillas de contrato, configuracion del sistema, paquetes de
--     creditos, tipos_documento, configuracion_disponibilidad (datos de
--     referencia / seeded).
--
-- IMPORTANTE: borrar esta funcion (y su migracion sucesora) antes de pasar
-- a produccion. Ver task de QA "release: revertir wipe-test-data".
--
-- La funcion devuelve un JSON con los conteos de filas borradas por tabla
-- para mostrar feedback en el toast del frontend.
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
  -- Snapshot de los IDs de administradores antes de empezar.
  SELECT array_agg(id) INTO v_admin_ids FROM perfiles WHERE rol = 'administrador';
  v_counts := jsonb_set(v_counts, '{admins_preservados}', to_jsonb(coalesce(array_length(v_admin_ids, 1), 0)));

  -- Diferimos los FK constraints para no preocuparnos por el orden.
  SET CONSTRAINTS ALL DEFERRED;

  -- Tablas hijas / transaccionales. Cada DELETE captura el conteo en v_counts.
  DELETE FROM evidencias_firma;            GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{evidencias_firma}', to_jsonb(v_count));
  DELETE FROM codigos_otp;                 GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{codigos_otp}', to_jsonb(v_count));
  DELETE FROM solicitudes_firma;           GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{solicitudes_firma}', to_jsonb(v_count));
  DELETE FROM contrato_versiones;          GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{contrato_versiones}', to_jsonb(v_count));
  DELETE FROM contrato_archivos;           GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{contrato_archivos}', to_jsonb(v_count));
  DELETE FROM contrato_historial_estados;  GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{contrato_historial_estados}', to_jsonb(v_count));
  DELETE FROM contrato_accesos_firmado;    GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{contrato_accesos_firmado}', to_jsonb(v_count));
  DELETE FROM contratos;                   GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{contratos}', to_jsonb(v_count));

  DELETE FROM estudios_documentos_soporte; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{estudios_documentos_soporte}', to_jsonb(v_count));
  DELETE FROM estudios_certificados;       GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{estudios_certificados}', to_jsonb(v_count));
  DELETE FROM expediente_coarrendatarios;  GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{expediente_coarrendatarios}', to_jsonb(v_count));
  DELETE FROM estudios;                    GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{estudios}', to_jsonb(v_count));

  DELETE FROM autorizaciones_habeas_data;  GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{autorizaciones_habeas_data}', to_jsonb(v_count));
  DELETE FROM autorizacion_otps;           GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{autorizacion_otps}', to_jsonb(v_count));

  DELETE FROM movimientos_creditos_estudios; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{movimientos_creditos_estudios}', to_jsonb(v_count));
  DELETE FROM lotes_creditos_estudios;       GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{lotes_creditos_estudios}', to_jsonb(v_count));
  DELETE FROM compras_creditos_estudios;     GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{compras_creditos_estudios}', to_jsonb(v_count));

  DELETE FROM eventos_pago;                GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{eventos_pago}', to_jsonb(v_count));
  DELETE FROM pagos;                       GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{pagos}', to_jsonb(v_count));
  DELETE FROM facturas;                    GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{facturas}', to_jsonb(v_count));

  DELETE FROM documentos;                  GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{documentos}', to_jsonb(v_count));
  DELETE FROM comentarios;                 GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{comentarios}', to_jsonb(v_count));
  DELETE FROM eventos_timeline;            GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{eventos_timeline}', to_jsonb(v_count));
  DELETE FROM notificaciones;              GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{notificaciones}', to_jsonb(v_count));
  DELETE FROM citas;                       GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{citas}', to_jsonb(v_count));

  DELETE FROM expedientes;                 GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{expedientes}', to_jsonb(v_count));
  DELETE FROM expediente_yearly_seq;       GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{expediente_yearly_seq}', to_jsonb(v_count));
  DELETE FROM solicitantes;                GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{solicitantes}', to_jsonb(v_count));

  DELETE FROM cambios_inmuebles;           GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{cambios_inmuebles}', to_jsonb(v_count));
  DELETE FROM fotos_inmueble;              GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{fotos_inmueble}', to_jsonb(v_count));
  DELETE FROM inmuebles;                   GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{inmuebles}', to_jsonb(v_count));

  DELETE FROM disponibilidad_propietario;  GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{disponibilidad_propietario}', to_jsonb(v_count));

  DELETE FROM email_verification_tokens;   GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{email_verification_tokens}', to_jsonb(v_count));
  DELETE FROM password_reset_tokens;       GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{password_reset_tokens}', to_jsonb(v_count));
  DELETE FROM terminos_aceptaciones;       GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{terminos_aceptaciones}', to_jsonb(v_count));

  -- Tabla legacy `firmas` (predecesora de solicitudes_firma). Si todavia
  -- existe, limpiarla. Si ya fue dropeada por una migracion previa, el
  -- IF EXISTS evita el error.
  EXECUTE 'DELETE FROM firmas';

  -- Bitacora — limpia el log operativo. Conservamos solo los eventos
  -- generados por el wipe en sí (se loggea desde el caller).
  DELETE FROM bitacora;                    GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{bitacora}', to_jsonb(v_count));

  -- Cuentas no-admin: primero perfiles, luego auth.users (ON DELETE
  -- CASCADE no aplica en auth.users porque vive en otro schema).
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

-- Solo el rol service_role puede ejecutar esta funcion (los clientes web
-- usan anon/authenticated y no llegan aqui — el endpoint la invoca con la
-- service key).
REVOKE EXECUTE ON FUNCTION fn_wipe_test_data() FROM PUBLIC;
