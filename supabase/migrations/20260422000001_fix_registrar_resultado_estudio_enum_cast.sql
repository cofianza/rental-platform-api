-- ============================================================
-- Fix: cast explícito text → resultado_estudio en fn_registrar_resultado_estudio
--
-- Bug: la función recibía p_resultado TEXT pero la columna estudios.resultado
-- es enum resultado_estudio. Postgres no hace cast automático entre text y
-- enum, así que el UPDATE fallaba con:
--   "column \"resultado\" is of type resultado_estudio but expression is of type text"
--
-- Fix: agregamos ::resultado_estudio en el UPDATE.
-- ============================================================

CREATE OR REPLACE FUNCTION fn_registrar_resultado_estudio(
  p_estudio_id UUID,
  p_resultado TEXT,
  p_observaciones TEXT,
  p_score INT DEFAULT NULL,
  p_motivo_rechazo TEXT DEFAULT NULL,
  p_condiciones TEXT DEFAULT NULL,
  p_certificado_url TEXT DEFAULT NULL,
  p_usuario_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_estado TEXT;
  v_resultado_actual TEXT;
  v_expediente_id UUID;
  v_inmueble_id UUID;
  v_descripcion TEXT;
BEGIN
  -- 1. Lock estudio row to prevent race conditions
  SELECT estado, resultado, expediente_id
  INTO v_estado, v_resultado_actual, v_expediente_id
  FROM estudios
  WHERE id = p_estudio_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Estudio no encontrado: %', p_estudio_id;
  END IF;

  -- 2. Validate estado
  IF v_estado NOT IN ('solicitado', 'en_proceso') THEN
    RAISE EXCEPTION 'Solo se puede registrar resultado en estudios en estado solicitado o en_proceso. Estado actual: %', v_estado;
  END IF;

  -- 3. Validate resultado still pendiente
  IF v_resultado_actual <> 'pendiente' THEN
    RAISE EXCEPTION 'Este estudio ya tiene un resultado registrado: %', v_resultado_actual;
  END IF;

  -- 4. Update estudio atomically (cast explícito text → resultado_estudio)
  UPDATE estudios
  SET resultado = p_resultado::resultado_estudio,
      observaciones = p_observaciones,
      estado = 'completado',
      fecha_completado = NOW(),
      score = COALESCE(p_score, score),
      motivo_rechazo = COALESCE(p_motivo_rechazo, motivo_rechazo),
      condiciones = COALESCE(p_condiciones, condiciones),
      certificado_url = COALESCE(p_certificado_url, certificado_url)
  WHERE id = p_estudio_id;

  -- 5. Get inmueble_id from expediente and revert to disponible
  SELECT inmueble_id INTO v_inmueble_id
  FROM expedientes
  WHERE id = v_expediente_id;

  IF v_inmueble_id IS NOT NULL THEN
    UPDATE inmuebles
    SET estado = 'disponible', updated_at = NOW()
    WHERE id = v_inmueble_id;
  END IF;

  -- 6. Build description
  v_descripcion := 'Resultado de estudio registrado: ' || p_resultado;

  -- 7. Insert timeline event
  INSERT INTO eventos_timeline (
    expediente_id, tipo, descripcion, usuario_id, metadata
  ) VALUES (
    v_expediente_id,
    'estudio',
    v_descripcion,
    p_usuario_id,
    jsonb_build_object(
      'estudio_id', p_estudio_id,
      'resultado', p_resultado,
      'score', p_score
    )
  );

  RETURN p_estudio_id;
END;
$$;
