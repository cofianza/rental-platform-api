-- ============================================================
-- HP-322: Proteccion tipos seed + reordenamiento atomico
-- ============================================================

-- Parte A: Columna es_protegido
ALTER TABLE tipos_documento
  ADD COLUMN IF NOT EXISTS es_protegido BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE tipos_documento
SET es_protegido = TRUE
WHERE codigo IN (
  'id_frontal', 'id_posterior', 'comprobante_domicilio',
  'comprobante_ingresos', 'referencias_personales',
  'referencias_laborales', 'selfie_con_id', 'otro'
);

-- Parte B: Funcion RPC para reordenamiento atomico
CREATE OR REPLACE FUNCTION reordenar_tipos_documento(p_items JSONB)
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
  v_item JSONB;
  v_id UUID;
  v_orden INTEGER;
  v_expected_count INTEGER;
  v_actual_count INTEGER;
  v_ids UUID[];
BEGIN
  -- Validar que la lista no esta vacia
  v_expected_count := jsonb_array_length(p_items);
  IF v_expected_count = 0 THEN
    RAISE EXCEPTION 'La lista de items esta vacia';
  END IF;

  -- Recolectar IDs
  SELECT array_agg((elem->>'id')::UUID)
  INTO v_ids
  FROM jsonb_array_elements(p_items) AS elem;

  -- Verificar que todos los IDs existen
  SELECT COUNT(*) INTO v_actual_count
  FROM tipos_documento
  WHERE id = ANY(v_ids);

  IF v_actual_count != v_expected_count THEN
    RAISE EXCEPTION 'Algunos tipos de documento no existen. Esperados: %, encontrados: %',
      v_expected_count, v_actual_count;
  END IF;

  -- Actualizar ordenes atomicamente
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_id := (v_item->>'id')::UUID;
    v_orden := (v_item->>'orden')::INTEGER;

    UPDATE tipos_documento
    SET orden = v_orden, updated_at = NOW()
    WHERE id = v_id;
  END LOOP;

  -- Retornar lista actualizada
  RETURN (
    SELECT json_agg(row_to_json(t) ORDER BY t.orden)
    FROM (
      SELECT id, codigo, nombre, descripcion, es_obligatorio,
             formatos_aceptados, tamano_maximo_mb, orden, activo,
             es_protegido, created_at, updated_at
      FROM tipos_documento
      ORDER BY orden ASC
    ) t
  );
END;
$$;
