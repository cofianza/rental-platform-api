-- HP-61: Funcion atomica para transicionar estado de expediente
-- Ejecuta UPDATE expedientes + INSERT eventos_timeline en una sola transaccion

CREATE OR REPLACE FUNCTION transicionar_expediente(
  p_expediente_id UUID,
  p_nuevo_estado estado_expediente,
  p_descripcion TEXT,
  p_usuario_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
  v_estado_anterior estado_expediente;
  v_expediente RECORD;
  v_evento_id UUID;
  v_transicion_valida BOOLEAN;
BEGIN
  -- Bloquear la fila para prevenir transiciones concurrentes
  SELECT estado INTO v_estado_anterior
  FROM expedientes
  WHERE id = p_expediente_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expediente no encontrado: %', p_expediente_id;
  END IF;

  -- Validar transición de estado permitida
  v_transicion_valida := CASE v_estado_anterior
    WHEN 'borrador'                THEN p_nuevo_estado IN ('en_revision', 'cerrado')
    WHEN 'en_revision'             THEN p_nuevo_estado IN ('informacion_incompleta', 'aprobado', 'rechazado', 'condicionado')
    WHEN 'informacion_incompleta'  THEN p_nuevo_estado IN ('en_revision', 'cerrado')
    WHEN 'aprobado'                THEN p_nuevo_estado IN ('cerrado')
    WHEN 'rechazado'               THEN p_nuevo_estado IN ('cerrado')
    WHEN 'condicionado'            THEN p_nuevo_estado IN ('en_revision', 'cerrado')
    WHEN 'cerrado'                 THEN FALSE
    ELSE FALSE
  END;

  IF NOT v_transicion_valida THEN
    RAISE EXCEPTION 'Transición no permitida: % → %', v_estado_anterior, p_nuevo_estado;
  END IF;

  -- Actualizar estado del expediente
  UPDATE expedientes
  SET estado = p_nuevo_estado,
      updated_at = NOW()
  WHERE id = p_expediente_id
  RETURNING * INTO v_expediente;

  -- Insertar evento de timeline
  INSERT INTO eventos_timeline (expediente_id, tipo, descripcion, usuario_id)
  VALUES (p_expediente_id, 'estado', p_descripcion, p_usuario_id)
  RETURNING id INTO v_evento_id;

  RETURN json_build_object(
    'expediente_id', p_expediente_id,
    'estado_anterior', v_estado_anterior,
    'estado_nuevo', p_nuevo_estado,
    'evento_timeline_id', v_evento_id,
    'updated_at', v_expediente.updated_at
  );
END;
$$;
