-- ============================================================
-- Fix: fn_cancelar_estudio should allow cancelling estudios
-- in any non-final state, not just 'solicitado'
-- ============================================================

CREATE OR REPLACE FUNCTION fn_cancelar_estudio(
  p_estudio_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_estado TEXT;
  v_expediente_id UUID;
  v_inmueble_id UUID;
BEGIN
  -- Lock estudio row
  SELECT estado, expediente_id INTO v_estado, v_expediente_id
  FROM estudios
  WHERE id = p_estudio_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Estudio no encontrado: %', p_estudio_id;
  END IF;

  -- Only block cancellation for already-final states
  IF v_estado IN ('completado', 'cancelado', 'fallido') THEN
    RAISE EXCEPTION 'No se puede cancelar un estudio en estado: %', v_estado;
  END IF;

  -- Update estudio to cancelado
  UPDATE estudios
  SET estado = 'cancelado', updated_at = NOW()
  WHERE id = p_estudio_id;

  -- Get inmueble_id from expediente
  SELECT inmueble_id INTO v_inmueble_id
  FROM expedientes
  WHERE id = v_expediente_id;

  -- Revert inmueble to disponible (only if currently en_estudio)
  IF v_inmueble_id IS NOT NULL THEN
    UPDATE inmuebles
    SET estado = 'disponible', updated_at = NOW()
    WHERE id = v_inmueble_id AND estado = 'en_estudio';
  END IF;

  RETURN p_estudio_id;
END;
$$;
