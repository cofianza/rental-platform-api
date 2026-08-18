-- ============================================================
-- fn_registrar_resultado_estudio: no liberar el inmueble cuando el
-- expediente ya está aprobado
--
-- El paso 5 liberaba el bloqueo temporal del inmueble ante cualquier estudio
-- con resultado 'rechazado', con el único guard `estado = 'en_estudio'` — sin
-- mirar en qué estado está el expediente dueño de esa reserva.
--
-- Escenario real (posible desde que existe el co-arrendatario):
--   1. Expediente 'condicionado' y estudio del co-arrendatario en vuelo.
--   2. El gestor no espera y aprueba manualmente → expediente 'aprobado'.
--      El inmueble sigue 'en_estudio': solo pasa a 'ocupado' al firmar.
--   3. Minutos después, el estudio del co-arrendatario completa 'rechazado'
--      → esta función lo pasa a 'disponible' y, si visible_vitrina está
--      encendido, el inmueble REAPARECE PUBLICADO.
--
-- Resultado: el inmueble queda ofertándose mientras el expediente aprobado
-- avanza hacia el contrato → doble arriendo posible hasta la firma.
--
-- La ponderación del co-arrendatario ya estaba protegida
-- (.eq('estado','condicionado') aborta sus efectos), pero eso corre DESPUÉS:
-- el inmueble ya había sido liberado dentro de esta función.
--
-- Fix: liberar solo si el expediente NO está 'aprobado'. Se deja fuera
-- únicamente ese estado a propósito:
--   - 'en_revision' / 'condicionado' → el rechazo sí cierra el caso, liberar
--     es correcto (comportamiento actual, sin cambios);
--   - 'cerrado' → si algo quedó reservado, liberarlo corrige una fuga;
--   - 'aprobado' → el expediente sigue vivo rumbo al contrato: la reserva
--     debe mantenerse.
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
  v_expediente_estado TEXT;
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

  -- 5. Liberar el bloqueo temporal del inmueble SOLO si el estudio fue
  --    RECHAZADO (el candidato no sigue) Y el expediente no fue aprobado.
  --    El guard estado='en_estudio' evita pisar un 'ocupado' legítimo; el
  --    guard sobre el expediente evita soltar la reserva de un expediente que
  --    ya va camino al contrato (ver cabecera de la migración).
  IF p_resultado = 'rechazado' THEN
    SELECT e.inmueble_id, e.estado::TEXT
    INTO v_inmueble_id, v_expediente_estado
    FROM expedientes e
    WHERE e.id = v_expediente_id;

    IF v_inmueble_id IS NOT NULL AND v_expediente_estado IS DISTINCT FROM 'aprobado' THEN
      UPDATE inmuebles
      SET estado = 'disponible', updated_at = NOW()
      WHERE id = v_inmueble_id
        AND estado = 'en_estudio';
    END IF;
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

COMMENT ON FUNCTION fn_registrar_resultado_estudio(UUID, TEXT, TEXT, INT, TEXT, TEXT, TEXT, UUID) IS
  'Registra el resultado de un estudio de forma atomica. Libera el bloqueo temporal del inmueble solo si el resultado es rechazado Y el expediente no esta aprobado (un expediente aprobado sigue rumbo al contrato y debe conservar la reserva).';
