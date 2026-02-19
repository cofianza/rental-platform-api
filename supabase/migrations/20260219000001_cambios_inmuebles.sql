-- ============================================================
-- Migracion: Historial de cambios por campo para inmuebles
-- Fecha: 2026-02-19
-- ============================================================

-- 1. Tabla cambios_inmuebles
CREATE TABLE IF NOT EXISTS cambios_inmuebles (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inmueble_id    UUID NOT NULL REFERENCES inmuebles(id) ON DELETE CASCADE,
  usuario_id     UUID NOT NULL REFERENCES perfiles(id),
  campo          VARCHAR(100) NOT NULL,
  valor_anterior TEXT,
  valor_nuevo    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indices
CREATE INDEX IF NOT EXISTS idx_cambios_inmuebles_inmueble ON cambios_inmuebles(inmueble_id);
CREATE INDEX IF NOT EXISTS idx_cambios_inmuebles_usuario ON cambios_inmuebles(usuario_id);
CREATE INDEX IF NOT EXISTS idx_cambios_inmuebles_campo ON cambios_inmuebles(campo);
CREATE INDEX IF NOT EXISTS idx_cambios_inmuebles_created ON cambios_inmuebles(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cambios_inmuebles_inmueble_created ON cambios_inmuebles(inmueble_id, created_at DESC);

-- RLS habilitado (sin policies: backend usa service_role)
ALTER TABLE cambios_inmuebles ENABLE ROW LEVEL SECURITY;

-- 2. Funcion RPC atomica: actualizar inmueble + registrar cambios por campo
DROP FUNCTION IF EXISTS update_inmueble_con_cambios(UUID, JSONB, UUID);

CREATE OR REPLACE FUNCTION update_inmueble_con_cambios(
  p_id UUID,
  p_data JSONB,
  p_user_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_old RECORD;
  v_key TEXT;
  v_old_val TEXT;
  v_new_val TEXT;
  v_changes_count INT := 0;
BEGIN
  -- 1. Obtener fila actual con bloqueo para evitar concurrencia
  SELECT * INTO v_old
  FROM public.inmuebles
  WHERE id = p_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inmueble no encontrado: %', p_id;
  END IF;

  -- 2. Actualizar el inmueble con los campos proporcionados
  UPDATE public.inmuebles
  SET
    direccion        = COALESCE((p_data->>'direccion'), direccion),
    ciudad           = COALESCE((p_data->>'ciudad'), ciudad),
    barrio           = CASE WHEN p_data ? 'barrio' THEN (p_data->>'barrio') ELSE barrio END,
    departamento     = COALESCE((p_data->>'departamento'), departamento),
    tipo             = COALESCE((p_data->>'tipo')::public.tipo_inmueble, tipo),
    uso              = COALESCE((p_data->>'uso')::public.uso_inmueble, uso),
    destinacion      = CASE WHEN p_data ? 'destinacion' THEN (p_data->>'destinacion') ELSE destinacion END,
    estrato          = COALESCE((p_data->>'estrato')::SMALLINT, estrato),
    valor_arriendo   = COALESCE((p_data->>'valor_arriendo')::NUMERIC(12,2), valor_arriendo),
    valor_comercial  = CASE WHEN p_data ? 'valor_comercial' THEN (p_data->>'valor_comercial')::NUMERIC(14,2) ELSE valor_comercial END,
    administracion   = COALESCE((p_data->>'administracion')::NUMERIC(10,2), administracion),
    area_m2          = CASE WHEN p_data ? 'area_m2' THEN (p_data->>'area_m2')::NUMERIC(8,2) ELSE area_m2 END,
    habitaciones     = COALESCE((p_data->>'habitaciones')::SMALLINT, habitaciones),
    banos            = COALESCE((p_data->>'banos')::SMALLINT, banos),
    parqueadero      = COALESCE((p_data->>'parqueadero')::BOOLEAN, parqueadero),
    parqueaderos     = CASE WHEN p_data ? 'parqueaderos' THEN (p_data->>'parqueaderos')::SMALLINT ELSE parqueaderos END,
    piso             = CASE WHEN p_data ? 'piso' THEN (p_data->>'piso') ELSE piso END,
    codigo_postal    = CASE WHEN p_data ? 'codigo_postal' THEN (p_data->>'codigo_postal') ELSE codigo_postal END,
    latitud          = CASE WHEN p_data ? 'latitud' THEN (p_data->>'latitud')::NUMERIC(10,7) ELSE latitud END,
    longitud         = CASE WHEN p_data ? 'longitud' THEN (p_data->>'longitud')::NUMERIC(10,7) ELSE longitud END,
    descripcion      = CASE WHEN p_data ? 'descripcion' THEN (p_data->>'descripcion') ELSE descripcion END,
    notas_internas   = CASE WHEN p_data ? 'notas_internas' THEN (p_data->>'notas_internas') ELSE notas_internas END,
    estado           = COALESCE((p_data->>'estado')::public.estado_inmueble, estado),
    propietario_id   = COALESCE((p_data->>'propietario_id')::UUID, propietario_id),
    visible_vitrina  = COALESCE((p_data->>'visible_vitrina')::BOOLEAN, visible_vitrina),
    foto_fachada_url = CASE WHEN p_data ? 'foto_fachada_url' THEN (p_data->>'foto_fachada_url') ELSE foto_fachada_url END,
    updated_at       = NOW()
  WHERE id = p_id;

  -- 3. Comparar cada campo enviado con el valor anterior e insertar cambios
  FOR v_key IN SELECT jsonb_object_keys(p_data)
  LOOP
    -- Valor anterior (del registro antes del update)
    v_old_val := CASE v_key
      WHEN 'direccion'        THEN v_old.direccion
      WHEN 'ciudad'           THEN v_old.ciudad
      WHEN 'barrio'           THEN v_old.barrio
      WHEN 'departamento'     THEN v_old.departamento
      WHEN 'tipo'             THEN v_old.tipo::TEXT
      WHEN 'uso'              THEN v_old.uso::TEXT
      WHEN 'destinacion'      THEN v_old.destinacion
      WHEN 'estrato'          THEN v_old.estrato::TEXT
      WHEN 'valor_arriendo'   THEN v_old.valor_arriendo::TEXT
      WHEN 'valor_comercial'  THEN v_old.valor_comercial::TEXT
      WHEN 'administracion'   THEN v_old.administracion::TEXT
      WHEN 'area_m2'          THEN v_old.area_m2::TEXT
      WHEN 'habitaciones'     THEN v_old.habitaciones::TEXT
      WHEN 'banos'            THEN v_old.banos::TEXT
      WHEN 'parqueadero'      THEN v_old.parqueadero::TEXT
      WHEN 'parqueaderos'     THEN v_old.parqueaderos::TEXT
      WHEN 'piso'             THEN v_old.piso
      WHEN 'codigo_postal'    THEN v_old.codigo_postal
      WHEN 'latitud'          THEN v_old.latitud::TEXT
      WHEN 'longitud'         THEN v_old.longitud::TEXT
      WHEN 'descripcion'      THEN v_old.descripcion
      WHEN 'notas_internas'   THEN v_old.notas_internas
      WHEN 'estado'           THEN v_old.estado::TEXT
      WHEN 'propietario_id'   THEN v_old.propietario_id::TEXT
      WHEN 'visible_vitrina'  THEN v_old.visible_vitrina::TEXT
      WHEN 'foto_fachada_url' THEN v_old.foto_fachada_url
      ELSE NULL
    END;

    -- Valor nuevo: normalizar al mismo tipo que la columna para evitar falsos positivos
    -- (ej: 2800000 vs 2800000.00 en campos NUMERIC)
    v_new_val := CASE v_key
      WHEN 'valor_arriendo'   THEN (p_data->>'valor_arriendo')::NUMERIC(12,2)::TEXT
      WHEN 'valor_comercial'  THEN (p_data->>'valor_comercial')::NUMERIC(14,2)::TEXT
      WHEN 'administracion'   THEN (p_data->>'administracion')::NUMERIC(10,2)::TEXT
      WHEN 'area_m2'          THEN (p_data->>'area_m2')::NUMERIC(8,2)::TEXT
      WHEN 'estrato'          THEN (p_data->>'estrato')::SMALLINT::TEXT
      WHEN 'habitaciones'     THEN (p_data->>'habitaciones')::SMALLINT::TEXT
      WHEN 'banos'            THEN (p_data->>'banos')::SMALLINT::TEXT
      WHEN 'parqueadero'      THEN (p_data->>'parqueadero')::BOOLEAN::TEXT
      WHEN 'parqueaderos'     THEN (p_data->>'parqueaderos')::SMALLINT::TEXT
      WHEN 'latitud'          THEN (p_data->>'latitud')::NUMERIC(10,7)::TEXT
      WHEN 'longitud'         THEN (p_data->>'longitud')::NUMERIC(10,7)::TEXT
      WHEN 'visible_vitrina'  THEN (p_data->>'visible_vitrina')::BOOLEAN::TEXT
      WHEN 'propietario_id'   THEN (p_data->>'propietario_id')::UUID::TEXT
      WHEN 'tipo'             THEN (p_data->>'tipo')::public.tipo_inmueble::TEXT
      WHEN 'uso'              THEN (p_data->>'uso')::public.uso_inmueble::TEXT
      WHEN 'estado'           THEN (p_data->>'estado')::public.estado_inmueble::TEXT
      ELSE p_data->>v_key
    END;

    -- Solo insertar si el valor realmente cambio (IS DISTINCT FROM maneja NULLs correctamente)
    IF (v_old_val IS DISTINCT FROM v_new_val) THEN
      INSERT INTO public.cambios_inmuebles (inmueble_id, usuario_id, campo, valor_anterior, valor_nuevo)
      VALUES (p_id, p_user_id, v_key, v_old_val, v_new_val);
      v_changes_count := v_changes_count + 1;
    END IF;
  END LOOP;

  RETURN json_build_object(
    'inmueble_id', p_id,
    'changes_count', v_changes_count,
    'updated_at', NOW()
  );
END;
$$;

-- 3. Recargar schema cache de PostgREST para que reconozca la nueva tabla
NOTIFY pgrst, 'reload schema';
