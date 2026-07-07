-- ============================================================
-- Fix vitrina/estado del inmueble en el ciclo de vida (auditoría jul-2026)
--
-- 1) fn_registrar_resultado_estudio liberaba el inmueble a 'disponible'
--    INCONDICIONALMENTE en TODO resultado:
--      - En 'aprobado'/'condicionado' el flujo SIGUE hacia el contrato: el
--        inmueble debe permanecer bloqueado ('en_estudio'), no volver a la
--        vitrina ni aceptar nuevos estudios.
--      - Sin guard de estado podía pisar un 'ocupado' legítimo (resultado
--        tardío/reintento del proveedor con otro contrato ya vigente).
--    Fix: solo libera en 'rechazado' y solo desde 'en_estudio' (mismo criterio
--    que liberarInmuebleEnEstudio en la capa de aplicación).
--
-- 2) Backfill: inmuebles con contrato VIGENTE que quedaron sin marcar
--    'ocupado' (activación manual / contrato en papel no marcaban) y/o con
--    visible_vitrina=true residual (bloquearInmuebleOcupado no apagaba el
--    flag). El dashboard los mostraba "En vitrina" estando arrendados
--    (bug Apt-001).
-- ============================================================

-- ── 1. RPC: liberar solo en rechazo y solo desde en_estudio ──

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

  -- 5. Liberar el bloqueo temporal del inmueble SOLO si el estudio fue
  --    RECHAZADO (el candidato no sigue). En aprobado/condicionado el flujo
  --    continúa hacia el contrato: el inmueble sigue 'en_estudio'. El guard
  --    estado='en_estudio' evita pisar un 'ocupado' legítimo.
  IF p_resultado = 'rechazado' THEN
    SELECT inmueble_id INTO v_inmueble_id
    FROM expedientes
    WHERE id = v_expediente_id;

    IF v_inmueble_id IS NOT NULL THEN
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

-- ── 2. Backfill: inmuebles con contrato vigente → ocupado + fuera de vitrina ──
-- Cubre activaciones pasadas por la ruta manual / contrato en papel que no
-- marcaban el inmueble. No toca 'inactivo' (decisión manual del dueño).

UPDATE inmuebles i
SET estado = 'ocupado', visible_vitrina = false, updated_at = NOW()
FROM expedientes e
JOIN contratos c ON c.expediente_id = e.id AND c.estado = 'vigente'
WHERE e.inmueble_id = i.id
  AND i.estado IN ('disponible', 'en_estudio');

-- ── 3. Backfill: flag residual en inmuebles ya ocupados (caso Apt-001) ──

UPDATE inmuebles
SET visible_vitrina = false, updated_at = NOW()
WHERE estado = 'ocupado' AND visible_vitrina = true;
