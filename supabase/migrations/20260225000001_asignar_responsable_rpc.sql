-- ============================================================
-- HP-285: Asignación atómica de responsable con evento timeline
-- ============================================================

-- 1. Columna metadata JSONB en eventos_timeline para datos estructurados por tipo
ALTER TABLE eventos_timeline
  ADD COLUMN IF NOT EXISTS metadata JSONB;

-- 2. RPC: asignar_responsable_expediente
--    Actualiza expedientes.analista_id + inserta evento timeline en una transacción
CREATE OR REPLACE FUNCTION asignar_responsable_expediente(
  p_expediente_id UUID,
  p_nuevo_analista_id UUID,
  p_usuario_id UUID,
  p_descripcion TEXT
)
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
  v_analista_anterior_id UUID;
  v_analista_anterior_nombre TEXT;
  v_analista_nuevo_nombre TEXT;
  v_evento_id UUID;
  v_expediente RECORD;
BEGIN
  -- 1. Bloquear la fila del expediente
  SELECT analista_id INTO v_analista_anterior_id
  FROM expedientes
  WHERE id = p_expediente_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expediente no encontrado: %', p_expediente_id;
  END IF;

  -- 2. Evitar reasignación al mismo analista
  IF v_analista_anterior_id IS NOT DISTINCT FROM p_nuevo_analista_id THEN
    RAISE EXCEPTION 'El analista seleccionado ya es el responsable actual';
  END IF;

  -- 3. Validar nuevo analista: existe, activo, rol correcto
  SELECT nombre || ' ' || apellido INTO v_analista_nuevo_nombre
  FROM perfiles
  WHERE id = p_nuevo_analista_id
    AND estado = 'activo'
    AND rol IN ('administrador', 'operador_analista');

  IF v_analista_nuevo_nombre IS NULL THEN
    RAISE EXCEPTION 'Analista no encontrado, inactivo o con rol no permitido';
  END IF;

  -- 4. Obtener nombre del analista anterior (si existe)
  IF v_analista_anterior_id IS NOT NULL THEN
    SELECT nombre || ' ' || apellido INTO v_analista_anterior_nombre
    FROM perfiles
    WHERE id = v_analista_anterior_id;
  END IF;

  -- 5. Actualizar expedientes.analista_id
  UPDATE expedientes
  SET analista_id = p_nuevo_analista_id,
      updated_at = NOW()
  WHERE id = p_expediente_id
  RETURNING * INTO v_expediente;

  -- 6. Insertar evento de timeline con metadata estructurada
  INSERT INTO eventos_timeline (
    expediente_id, tipo, descripcion, usuario_id, metadata
  )
  VALUES (
    p_expediente_id,
    'asignacion',
    p_descripcion,
    p_usuario_id,
    json_build_object(
      'analista_anterior_id', v_analista_anterior_id,
      'analista_anterior', v_analista_anterior_nombre,
      'analista_nuevo_id', p_nuevo_analista_id,
      'analista_nuevo', v_analista_nuevo_nombre
    )::jsonb
  )
  RETURNING id INTO v_evento_id;

  RETURN json_build_object(
    'expediente_id', p_expediente_id,
    'analista_anterior_id', v_analista_anterior_id,
    'analista_nuevo_id', p_nuevo_analista_id,
    'evento_timeline_id', v_evento_id,
    'updated_at', v_expediente.updated_at
  );
END;
$$;
