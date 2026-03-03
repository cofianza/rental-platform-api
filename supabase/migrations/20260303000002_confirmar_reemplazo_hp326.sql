-- HP-326: RPC atomico para confirmar reemplazo de documento rechazado
-- INSERT nuevo doc + UPDATE doc original en una sola transaccion

CREATE OR REPLACE FUNCTION confirmar_reemplazo_documento(
  p_doc_id UUID,
  p_nombre_original TEXT,
  p_nombre_archivo TEXT,
  p_storage_key TEXT,
  p_tipo_mime TEXT,
  p_tamano_bytes BIGINT,
  p_usuario_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
  v_original RECORD;
  v_version INTEGER;
  v_new_id UUID;
  v_result JSON;
BEGIN
  -- 1. Obtener y validar documento original
  SELECT id, expediente_id, tipo_documento_id, estado
  INTO v_original
  FROM documentos
  WHERE id = p_doc_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Documento no encontrado' USING ERRCODE = 'P0002';
  END IF;

  IF v_original.estado != 'rechazado' THEN
    RAISE EXCEPTION 'Documento no esta en estado rechazado' USING ERRCODE = 'P0003';
  END IF;

  -- 2. Calcular version
  SELECT COUNT(*) + 1 INTO v_version
  FROM documentos
  WHERE expediente_id = v_original.expediente_id
    AND tipo_documento_id = v_original.tipo_documento_id;

  -- 3. INSERT nuevo documento
  INSERT INTO documentos (
    expediente_id, tipo_documento_id, nombre_original, nombre_archivo,
    storage_key, tipo_mime, tamano_bytes, estado, version, subido_por
  ) VALUES (
    v_original.expediente_id, v_original.tipo_documento_id,
    p_nombre_original, p_nombre_archivo, p_storage_key, p_tipo_mime,
    p_tamano_bytes, 'pendiente', v_version, p_usuario_id
  )
  RETURNING id INTO v_new_id;

  -- 4. UPDATE documento original -> reemplazado
  UPDATE documentos
  SET estado = 'reemplazado',
      reemplazado_por = v_new_id,
      updated_at = NOW()
  WHERE id = p_doc_id;

  -- 5. Retornar nuevo documento completo
  SELECT row_to_json(d) INTO v_result
  FROM (
    SELECT id, expediente_id, tipo_documento_id, archivo_url, nombre_original,
           nombre_archivo, storage_key, tipo_mime, tamano_bytes, estado,
           motivo_rechazo, version, validado_por, subido_por, fecha_revision,
           reemplazado_por, metadatos, created_at, updated_at
    FROM documentos
    WHERE id = v_new_id
  ) d;

  RETURN v_result;
END;
$$;
