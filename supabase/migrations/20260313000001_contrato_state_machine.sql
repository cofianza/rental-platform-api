-- ============================================================
-- Motor de estados de contratos
-- Nuevos valores de enum, columnas, tabla historial y RPC
-- ============================================================

-- 1. Agregar nuevos valores al enum estado_contrato
ALTER TYPE estado_contrato ADD VALUE IF NOT EXISTS 'en_revision';
ALTER TYPE estado_contrato ADD VALUE IF NOT EXISTS 'aprobado';

-- 2. Nuevas columnas en contratos
ALTER TABLE contratos
  ADD COLUMN IF NOT EXISTS fecha_firma TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fecha_terminacion TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS motivo_cancelacion TEXT,
  ADD COLUMN IF NOT EXISTS contrato_padre_id UUID REFERENCES contratos(id) ON DELETE SET NULL;

-- 3. Tabla de historial de estados de contratos
CREATE TABLE IF NOT EXISTS contrato_historial_estados (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contrato_id      UUID NOT NULL REFERENCES contratos(id) ON DELETE CASCADE,
  estado_anterior  estado_contrato NOT NULL,
  estado_nuevo     estado_contrato NOT NULL,
  comentario       TEXT,
  motivo           TEXT,
  descripcion      TEXT NOT NULL,
  usuario_id       UUID REFERENCES perfiles(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contrato_historial_contrato_id
  ON contrato_historial_estados(contrato_id);

-- 4. RPC transicionar_contrato — transicion atomica con FOR UPDATE lock
CREATE OR REPLACE FUNCTION transicionar_contrato(
  p_contrato_id UUID,
  p_nuevo_estado estado_contrato,
  p_descripcion TEXT,
  p_usuario_id UUID,
  p_comentario TEXT DEFAULT NULL,
  p_motivo TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
  v_estado_anterior estado_contrato;
  v_contrato RECORD;
  v_historial_id UUID;
  v_transicion_valida BOOLEAN;
BEGIN
  -- Bloquear la fila para prevenir transiciones concurrentes
  SELECT estado INTO v_estado_anterior
  FROM contratos
  WHERE id = p_contrato_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contrato no encontrado: %', p_contrato_id;
  END IF;

  -- Validar transicion de estado permitida
  v_transicion_valida := CASE v_estado_anterior
    WHEN 'borrador'          THEN p_nuevo_estado IN ('en_revision', 'cancelado')
    WHEN 'en_revision'       THEN p_nuevo_estado IN ('aprobado', 'borrador', 'cancelado')
    WHEN 'aprobado'          THEN p_nuevo_estado IN ('pendiente_firma', 'borrador', 'cancelado')
    WHEN 'pendiente_firma'   THEN p_nuevo_estado IN ('firmado', 'cancelado')
    WHEN 'firmado'           THEN p_nuevo_estado IN ('vigente')
    WHEN 'vigente'           THEN p_nuevo_estado IN ('finalizado', 'cancelado')
    WHEN 'finalizado'        THEN FALSE
    WHEN 'cancelado'         THEN FALSE
    ELSE FALSE
  END;

  IF NOT v_transicion_valida THEN
    RAISE EXCEPTION 'Transicion no permitida: % -> %', v_estado_anterior, p_nuevo_estado;
  END IF;

  -- Actualizar estado del contrato
  UPDATE contratos
  SET estado = p_nuevo_estado,
      updated_at = NOW()
  WHERE id = p_contrato_id
  RETURNING * INTO v_contrato;

  -- Insertar en historial de estados
  INSERT INTO contrato_historial_estados (
    contrato_id, estado_anterior, estado_nuevo,
    comentario, motivo, descripcion, usuario_id
  )
  VALUES (
    p_contrato_id, v_estado_anterior, p_nuevo_estado,
    p_comentario, p_motivo, p_descripcion, p_usuario_id
  )
  RETURNING id INTO v_historial_id;

  RETURN json_build_object(
    'contrato_id', p_contrato_id,
    'estado_anterior', v_estado_anterior,
    'estado_nuevo', p_nuevo_estado,
    'historial_id', v_historial_id,
    'updated_at', v_contrato.updated_at
  );
END;
$$;
