-- ============================================================
-- Migración: fn_habilitar_estudio_expediente
-- Fecha: 2026-04-17
-- Descripción:
--   RPC atómica para el paso 3 del flujo de Cofianza. Marca el
--   expediente como habilitado para estudio, crea el registro
--   placeholder en `estudios` y registra el evento en timeline
--   dentro de una única transacción.
--
--   Validaciones (todas lanzan RAISE EXCEPTION con mensaje
--   parseado por el service en Node):
--     - Expediente existe.
--     - estudio_habilitado = false (idempotencia → 409).
--     - estado ∈ ('borrador','en_revision','informacion_incompleta').
--     - Si source != 'invitacion': al menos una cita en estado
--       'realizada'. Los expedientes de invitación saltan el gate
--       (ya son habilitados por vincularExpedienteExterno; este
--       endpoint queda como fallback si alguno quedó con flag=false).
--
--   Retorna JSON { expediente_id, numero, estudio_id } suficiente
--   para que el caller componga la respuesta HTTP sin más queries.
-- ============================================================

CREATE OR REPLACE FUNCTION fn_habilitar_estudio_expediente(
  p_expediente_id UUID,
  p_user_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
  v_id UUID;
  v_numero TEXT;
  v_estado TEXT;
  v_source TEXT;
  v_estudio_habilitado BOOLEAN;
  v_estudio_id UUID;
  v_cita_realizada_count INT;
BEGIN
  -- 1. Lock + fetch del expediente para prevenir condición de carrera.
  SELECT id, numero, estado::TEXT, source::TEXT, estudio_habilitado
    INTO v_id, v_numero, v_estado, v_source, v_estudio_habilitado
    FROM expedientes
   WHERE id = p_expediente_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expediente no encontrado: %', p_expediente_id;
  END IF;

  -- 2. Idempotencia: si ya estaba habilitado, conflicto.
  IF v_estudio_habilitado = TRUE THEN
    RAISE EXCEPTION 'Estudio ya habilitado para este expediente';
  END IF;

  -- 3. Rango de estados permitido.
  IF v_estado NOT IN ('borrador', 'en_revision', 'informacion_incompleta') THEN
    RAISE EXCEPTION 'Estado no permitido para habilitar estudio: %', v_estado;
  END IF;

  -- 4. Gate de cita realizada. Se salta solo cuando source='invitacion'.
  --    IS DISTINCT FROM trata NULL como valor distinto (defensivo por si
  --    alguna fila legada quedó con source NULL antes del migration enum).
  IF v_source IS DISTINCT FROM 'invitacion' THEN
    SELECT COUNT(*) INTO v_cita_realizada_count
      FROM citas
     WHERE expediente_id = p_expediente_id
       AND estado = 'realizada';

    IF v_cita_realizada_count = 0 THEN
      RAISE EXCEPTION 'Se requiere al menos una cita realizada antes de habilitar el estudio';
    END IF;
  END IF;

  -- 5. UPDATE expediente.
  UPDATE expedientes
     SET estudio_habilitado = TRUE,
         updated_at = NOW()
   WHERE id = p_expediente_id;

  -- 6. INSERT placeholder en estudios. Los defaults del schema cubren
  --    estado='solicitado', resultado='pendiente', fecha_solicitud=NOW().
  INSERT INTO estudios (
    expediente_id, tipo, proveedor, solicitado_por
  ) VALUES (
    p_expediente_id,
    'individual'::tipo_estudio,
    'transunion'::proveedor_estudio,
    p_user_id
  )
  RETURNING id INTO v_estudio_id;

  -- 7. Timeline event atómico (tipo='estudio' cubre este tipo de eventos).
  INSERT INTO eventos_timeline (
    expediente_id, tipo, descripcion, usuario_id, metadata
  ) VALUES (
    p_expediente_id,
    'estudio',
    'Estudio crediticio habilitado',
    p_user_id,
    json_build_object('estudio_id', v_estudio_id, 'via', 'panel')
  );

  RETURN json_build_object(
    'expediente_id', v_id,
    'numero', v_numero,
    'estudio_id', v_estudio_id
  );
END;
$$;
