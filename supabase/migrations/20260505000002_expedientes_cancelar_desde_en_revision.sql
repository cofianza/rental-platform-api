-- ============================================================
-- Permitir cancelar (cerrar) un expediente desde 'en_revision' y alinear
-- la RPC con el state machine de TypeScript.
--
-- Mario (5-may-2026): el dueño del inmueble debe poder abandonar el
-- proceso en cualquier momento, no solo cuando ya está aprobado o
-- rechazado. La RPC actual rechazaba 'en_revision' → 'cerrado' aunque
-- el state machine de TypeScript ya lo permite con motivo obligatorio.
--
-- Mantenemos la misma signature (p_comentario) — el motivo lo valida el
-- service antes de llamar a la RPC. Solo cambia el CASE de transiciones
-- válidas para alinearlo con expediente-state-machine.ts:
--   - 'en_revision' → 'cerrado' (cancelación con comentario)
--   - 'condicionado' → 'aprobado' / 'rechazado' (decisión manual del propietario)
-- ============================================================

CREATE OR REPLACE FUNCTION transicionar_expediente(
  p_expediente_id UUID,
  p_nuevo_estado estado_expediente,
  p_descripcion TEXT,
  p_usuario_id UUID,
  p_comentario TEXT DEFAULT NULL
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
  SELECT estado INTO v_estado_anterior
  FROM expedientes
  WHERE id = p_expediente_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expediente no encontrado: %', p_expediente_id;
  END IF;

  v_transicion_valida := CASE v_estado_anterior
    WHEN 'borrador'                THEN p_nuevo_estado IN ('en_revision', 'cerrado')
    WHEN 'en_revision'             THEN p_nuevo_estado IN ('informacion_incompleta', 'aprobado', 'rechazado', 'condicionado', 'cerrado')
    WHEN 'informacion_incompleta'  THEN p_nuevo_estado IN ('en_revision', 'cerrado')
    WHEN 'aprobado'                THEN p_nuevo_estado IN ('cerrado')
    WHEN 'rechazado'               THEN p_nuevo_estado IN ('cerrado')
    WHEN 'condicionado'            THEN p_nuevo_estado IN ('aprobado', 'rechazado', 'en_revision', 'cerrado')
    WHEN 'cerrado'                 THEN FALSE
    ELSE FALSE
  END;

  IF NOT v_transicion_valida THEN
    RAISE EXCEPTION 'Transición no permitida: % → %', v_estado_anterior, p_nuevo_estado;
  END IF;

  UPDATE expedientes
  SET estado = p_nuevo_estado,
      updated_at = NOW()
  WHERE id = p_expediente_id
  RETURNING * INTO v_expediente;

  INSERT INTO eventos_timeline (
    expediente_id, tipo, descripcion, usuario_id,
    estado_anterior, estado_nuevo, comentario
  )
  VALUES (
    p_expediente_id, 'estado', p_descripcion, p_usuario_id,
    v_estado_anterior, p_nuevo_estado, p_comentario
  )
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
