-- ============================================================
-- HP-328 fix: RPCs atómicas para crear y cancelar estudios
-- ============================================================

-- ============================================================
-- 1. fn_crear_estudio: atomic insert estudio + update inmueble
-- ============================================================
CREATE OR REPLACE FUNCTION fn_crear_estudio(
  p_expediente_id UUID,
  p_inmueble_id UUID,
  p_tipo TEXT,
  p_proveedor TEXT,
  p_duracion_contrato_meses INT,
  p_pago_por TEXT,
  p_observaciones TEXT DEFAULT NULL,
  p_solicitado_por UUID DEFAULT NULL,
  p_autorizacion_habeas_data_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_estudio_id UUID;
  v_inmueble_estado TEXT;
BEGIN
  -- Lock inmueble row to prevent race conditions
  SELECT estado INTO v_inmueble_estado
  FROM inmuebles
  WHERE id = p_inmueble_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inmueble no encontrado: %', p_inmueble_id;
  END IF;

  IF v_inmueble_estado = 'en_estudio' THEN
    RAISE EXCEPTION 'El inmueble ya tiene un estudio en proceso';
  END IF;

  -- Insert estudio
  INSERT INTO estudios (
    expediente_id, tipo, proveedor, estado, resultado,
    duracion_contrato_meses, pago_por, observaciones,
    solicitado_por, autorizacion_habeas_data_id
  ) VALUES (
    p_expediente_id,
    p_tipo::tipo_estudio,
    p_proveedor::proveedor_estudio,
    'solicitado',
    'pendiente',
    p_duracion_contrato_meses,
    p_pago_por,
    p_observaciones,
    p_solicitado_por,
    p_autorizacion_habeas_data_id
  )
  RETURNING id INTO v_estudio_id;

  -- Update inmueble to en_estudio atomically
  UPDATE inmuebles
  SET estado = 'en_estudio', updated_at = NOW()
  WHERE id = p_inmueble_id;

  RETURN v_estudio_id;
END;
$$;

-- ============================================================
-- 2. fn_cancelar_estudio: atomic cancel + revert inmueble
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

  IF v_estado <> 'solicitado' THEN
    RAISE EXCEPTION 'Solo se pueden cancelar estudios en estado solicitado. Estado actual: %', v_estado;
  END IF;

  -- Update estudio to cancelado
  UPDATE estudios
  SET estado = 'cancelado'
  WHERE id = p_estudio_id;

  -- Get inmueble_id from expediente
  SELECT inmueble_id INTO v_inmueble_id
  FROM expedientes
  WHERE id = v_expediente_id;

  -- Revert inmueble to disponible
  IF v_inmueble_id IS NOT NULL THEN
    UPDATE inmuebles
    SET estado = 'disponible', updated_at = NOW()
    WHERE id = v_inmueble_id;
  END IF;

  RETURN p_estudio_id;
END;
$$;

-- ============================================================
-- 3. fn_crear_estudio_desde_inmueble: atomic expediente + estudio
-- ============================================================
CREATE OR REPLACE FUNCTION fn_crear_estudio_desde_inmueble(
  p_inmueble_id UUID,
  p_solicitante_id UUID,
  p_tipo TEXT,
  p_proveedor TEXT,
  p_duracion_contrato_meses INT,
  p_pago_por TEXT,
  p_observaciones TEXT DEFAULT NULL,
  p_solicitado_por UUID DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
  v_inmueble_estado TEXT;
  v_expediente_id UUID;
  v_estudio_id UUID;
  v_autorizacion_id UUID;
BEGIN
  -- 1. Lock and validate inmueble
  SELECT estado INTO v_inmueble_estado
  FROM inmuebles
  WHERE id = p_inmueble_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inmueble no encontrado: %', p_inmueble_id;
  END IF;

  IF v_inmueble_estado = 'en_estudio' THEN
    RAISE EXCEPTION 'El inmueble ya tiene un estudio en proceso';
  END IF;

  -- 2. Validate solicitante exists
  IF NOT EXISTS (SELECT 1 FROM solicitantes WHERE id = p_solicitante_id) THEN
    RAISE EXCEPTION 'Solicitante no encontrado: %', p_solicitante_id;
  END IF;

  -- 3. Create expediente
  INSERT INTO expedientes (inmueble_id, solicitante_id, creado_por)
  VALUES (p_inmueble_id, p_solicitante_id, p_solicitado_por)
  RETURNING id INTO v_expediente_id;

  -- 4. Check if autorizacion habeas data exists for this new expediente
  -- (Normally won't exist for a brand new expediente, so we skip that check here.
  --  The caller must handle autorizacion separately if required.)

  -- 5. Insert estudio
  INSERT INTO estudios (
    expediente_id, tipo, proveedor, estado, resultado,
    duracion_contrato_meses, pago_por, observaciones,
    solicitado_por
  ) VALUES (
    v_expediente_id,
    p_tipo::tipo_estudio,
    p_proveedor::proveedor_estudio,
    'solicitado',
    'pendiente',
    p_duracion_contrato_meses,
    p_pago_por,
    p_observaciones,
    p_solicitado_por
  )
  RETURNING id INTO v_estudio_id;

  -- 6. Update inmueble to en_estudio
  UPDATE inmuebles
  SET estado = 'en_estudio', updated_at = NOW()
  WHERE id = p_inmueble_id;

  RETURN json_build_object(
    'expediente_id', v_expediente_id,
    'estudio_id', v_estudio_id
  );
END;
$$;
