-- ============================================================
-- Omitir cita cuando ya hubo contacto/visita por fuera (tarea 3.2)
-- ------------------------------------------------------------
-- Caso: el arrendatario dio "Me interesa", coordinaron la visita por WhatsApp
-- y la realizaron por fuera. La inmobiliaria crea el expediente pero el sistema
-- exige una cita 'realizada' para habilitar el estudio. Ahora el gestor puede
-- marcar `cita_omitida = true` y el gate de la RPC lo salta (igual que hace
-- 'invitacion').
-- ============================================================

ALTER TABLE public.expedientes
  ADD COLUMN IF NOT EXISTS cita_omitida BOOLEAN NOT NULL DEFAULT false;

-- Recrear la RPC del paso 3 para que el gate de cita también se salte cuando
-- cita_omitida = true (además de source='invitacion').
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
  v_cita_omitida BOOLEAN;
  v_estudio_id UUID;
  v_cita_realizada_count INT;
BEGIN
  -- 1. Lock + fetch del expediente para prevenir condición de carrera.
  SELECT id, numero, estado::TEXT, source::TEXT, estudio_habilitado, cita_omitida
    INTO v_id, v_numero, v_estado, v_source, v_estudio_habilitado, v_cita_omitida
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

  -- 4. Gate de cita realizada. Se salta cuando source='invitacion' O cuando el
  --    gestor marcó cita_omitida=true (visita coordinada por fuera).
  IF v_source IS DISTINCT FROM 'invitacion' AND v_cita_omitida IS NOT TRUE THEN
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

  -- 6. INSERT placeholder en estudios.
  INSERT INTO estudios (
    expediente_id, tipo, proveedor, solicitado_por
  ) VALUES (
    p_expediente_id,
    'individual'::tipo_estudio,
    'transunion'::proveedor_estudio,
    p_user_id
  )
  RETURNING id INTO v_estudio_id;

  -- 7. Timeline event atómico.
  INSERT INTO eventos_timeline (
    expediente_id, tipo, descripcion, usuario_id, metadata
  ) VALUES (
    p_expediente_id,
    'estudio',
    'Estudio crediticio habilitado',
    p_user_id,
    json_build_object('estudio_id', v_estudio_id, 'via', 'panel', 'cita_omitida', v_cita_omitida)
  );

  RETURN json_build_object(
    'expediente_id', v_id,
    'numero', v_numero,
    'estudio_id', v_estudio_id
  );
END;
$$;
