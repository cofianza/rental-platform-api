-- ============================================================
-- fn_habilitar_estudio_expediente: elegir el buró al habilitar
--
-- Hasta ahora la función creaba el estudio placeholder con
-- 'transunion'::proveedor_estudio hardcodeado, así que el camino de
-- propietario/inmobiliaria ("Habilitar estudio" desde el expediente) nunca
-- daba a elegir buró — aunque el camino de admin/operador (fn_crear_estudio)
-- sí recibía p_proveedor desde hace tiempo.
--
-- Ahora acepta p_proveedor con DEFAULT 'transunion', de modo que:
--   - las llamadas existentes de 2 argumentos siguen funcionando igual;
--   - la API puede pasar 'datacredito' cuando el gestor lo elija.
--
-- Solo se admiten los burós EJECUTABLES por provider. 'manual' y 'sifin'
-- quedan fuera a propósito: 'sifin' es un stub que lanza
-- PROVIDER_NOT_IMPLEMENTED y 'manual' no se consulta automáticamente, así que
-- crear el placeholder con cualquiera de los dos dejaría al solicitante en un
-- callejón sin salida tras pagar.
-- ============================================================

-- La versión vigente es fn_habilitar_estudio_expediente(UUID, UUID). Agregar un
-- tercer parámetro con DEFAULT no la reemplaza: crea una SOBRECARGA, y
-- entonces una llamada de dos argumentos queda ambigua entre ambas
-- ("function fn_habilitar_estudio_expediente(uuid, uuid) is not unique").
-- Por eso se elimina explícitamente la de dos parámetros antes de crear la
-- nueva.
DROP FUNCTION IF EXISTS fn_habilitar_estudio_expediente(UUID, UUID);

CREATE OR REPLACE FUNCTION fn_habilitar_estudio_expediente(
  p_expediente_id UUID,
  p_user_id UUID,
  p_proveedor TEXT DEFAULT 'transunion'
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
  -- 0. Validar el buró antes de tocar nada.
  IF p_proveedor NOT IN ('transunion', 'datacredito') THEN
    RAISE EXCEPTION 'Proveedor no ejecutable para habilitar estudio: % (use transunion o datacredito)', p_proveedor;
  END IF;

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

  -- 6. INSERT placeholder en estudios, con el buró elegido.
  INSERT INTO estudios (
    expediente_id, tipo, proveedor, solicitado_por
  ) VALUES (
    p_expediente_id,
    'individual'::tipo_estudio,
    p_proveedor::proveedor_estudio,
    p_user_id
  )
  RETURNING id INTO v_estudio_id;

  -- 7. Timeline event atómico. Se registra el buró elegido para que quede
  --    trazado quién decidió consultar a cuál.
  INSERT INTO eventos_timeline (
    expediente_id, tipo, descripcion, usuario_id, metadata
  ) VALUES (
    p_expediente_id,
    'estudio',
    'Estudio crediticio habilitado',
    p_user_id,
    json_build_object(
      'estudio_id', v_estudio_id,
      'via', 'panel',
      'cita_omitida', v_cita_omitida,
      'proveedor', p_proveedor
    )
  );

  RETURN json_build_object(
    'expediente_id', v_id,
    'numero', v_numero,
    'estudio_id', v_estudio_id,
    'proveedor', p_proveedor
  );
END;
$$;

COMMENT ON FUNCTION fn_habilitar_estudio_expediente(UUID, UUID, TEXT) IS
  'Habilita el estudio de un expediente y crea el placeholder en estudios con el buro elegido (transunion|datacredito). p_proveedor por defecto transunion para compatibilidad con las llamadas de 2 argumentos.';
