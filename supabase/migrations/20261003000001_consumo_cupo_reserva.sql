-- ============================================================
-- Adenda de precios v1.0 §2 — Consumo de cupo: reserva → consumo
--
-- §2.1 El cupo se consume cuando la consulta a centrales PRODUCE RESULTADO.
-- §2.2 Tres desenlaces; solo el (c) consume:
--      (a) la persona no existe en la central; (b) falla del servicio o
--      respuesta no utilizable; (c) la central entrega información utilizable.
-- §2.4 No existe reversa de un cupo consumido bajo (c).
-- §2.5 Tampoco consume el estudio que nunca llega a la consulta.
-- §2.6 Cada consumo queda con fecha y hora, paquete y la consulta que lo
--      generó; cada no-consumo, con su literal.
--
-- Modelo: al liberar el estudio con crédito se sigue descontando del lote (el
-- gate de pago §6.3 y uq_pagos_estudio_activo no cambian), pero el movimiento
-- pasa a ser 'reserva'. Con resultado (c) se confirma con un movimiento
-- 'consumo' (cantidad 0: el lote ya se descontó) que guarda el estudio y la
-- referencia del proveedor. En (a), (b) o §2.5 se registra 'liberacion' con su
-- literal y el cupo vuelve al MISMO lote; si el lote ya venció, se extingue
-- (cantidad 0). Los 'consumo' de cantidad -1 sin literal son los de antes de
-- esta migración: se tratan como una reserva abierta.
--
-- Qué hace:
--   1. Tipos 'reserva' y 'liberacion' en tipo_movimiento_creditos.
--   2. estudios.desenlace_consulta ('a_no_existe' | 'b_falla' | 'c_resultado').
--   3. movimientos_creditos_estudios: estudio_id, referencia_proveedor, literal.
--      Un solo consumo confirmado por pago (índice único parcial).
--   4. consume_credito_estudio registra 'reserva' (mismo orden de consumo que
--      20261002000101: vence antes primero).
--   5. RPC nuevas, atómicas por pago (advisory lock): confirmar_consumo_credito,
--      liberar_reserva_credito y reactivar_reserva_credito.
--
-- Ninguna función es SECURITY DEFINER; igual se fija search_path y se quita
-- EXECUTE a PUBLIC y anon: solo las llama el API con service_role.
--
-- ORDEN: correr ANTES de desplegar la API de esta rama (la API llama las RPC
-- nuevas y escribe las columnas nuevas).
--
-- Idempotente: IF NOT EXISTS / CREATE OR REPLACE. No cambia filas existentes.
-- ============================================================

-- 1. Tipos de movimiento (fuera de uso dentro de esta misma transacción: solo
--    los usan cuerpos plpgsql, que se resuelven al ejecutarse).
ALTER TYPE tipo_movimiento_creditos ADD VALUE IF NOT EXISTS 'reserva';
ALTER TYPE tipo_movimiento_creditos ADD VALUE IF NOT EXISTS 'liberacion';

-- 2. Desenlace de la consulta del estudio
ALTER TABLE estudios ADD COLUMN IF NOT EXISTS desenlace_consulta TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'estudios_desenlace_consulta_valido') THEN
    ALTER TABLE estudios
      ADD CONSTRAINT estudios_desenlace_consulta_valido
      CHECK (desenlace_consulta IS NULL OR desenlace_consulta IN ('a_no_existe', 'b_falla', 'c_resultado'));
  END IF;
END $$;
COMMENT ON COLUMN estudios.desenlace_consulta IS
  'Adenda de precios §2.2: a_no_existe (la persona no existe en la central), b_falla (falla o respuesta no utilizable), c_resultado (consume cupo). NULL = no llegó a la consulta.';

-- 3. Registro de la consulta en los movimientos (§2.6)
ALTER TABLE movimientos_creditos_estudios
  ADD COLUMN IF NOT EXISTS estudio_id UUID REFERENCES estudios(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS referencia_proveedor TEXT,
  ADD COLUMN IF NOT EXISTS literal TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'movimientos_creditos_literal_valido') THEN
    ALTER TABLE movimientos_creditos_estudios
      ADD CONSTRAINT movimientos_creditos_literal_valido
      CHECK (literal IS NULL OR literal IN ('a', 'b', 'c', '2.5'));
  END IF;
END $$;
COMMENT ON COLUMN movimientos_creditos_estudios.literal IS
  'Adenda de precios §2.6: c = consumo con resultado; a, b o 2.5 = por qué la reserva no se consumió.';

-- Un solo consumo confirmado por pago: la cascada, la re-consulta y el
-- estudio del co-arrendatario se amparan en el mismo cupo.
CREATE UNIQUE INDEX IF NOT EXISTS uq_movimientos_creditos_consumo_pago
  ON movimientos_creditos_estudios(pago_id) WHERE literal = 'c';
CREATE INDEX IF NOT EXISTS idx_movimientos_creditos_pago
  ON movimientos_creditos_estudios(pago_id, created_at) WHERE pago_id IS NOT NULL;

-- 4. La reserva (antes 'consumo'). created_at con clock_timestamp: el último
--    movimiento del pago decide su estado y dos transacciones pueden empezar
--    en desorden.
CREATE OR REPLACE FUNCTION public.consume_credito_estudio(
  p_perfil_id UUID,
  p_expediente_id UUID,
  p_solicitante_id UUID,
  p_pago_id UUID,
  p_usuario_id UUID,
  p_notas TEXT DEFAULT NULL
)
RETURNS TABLE(lote_id UUID, saldo_restante INTEGER)
SET search_path = public
AS $$
DECLARE
  v_lote_id UUID;
  v_saldo INTEGER;
BEGIN
  SELECT l.id INTO v_lote_id
  FROM lotes_creditos_estudios l
  LEFT JOIN compras_creditos_estudios c ON c.id = l.compra_id
  WHERE l.perfil_id = p_perfil_id
    AND l.cantidad_disponible > 0
    AND (l.vence_en IS NULL OR l.vence_en > NOW())
  ORDER BY l.vence_en ASC NULLS LAST,
           COALESCE(c.created_at, l.created_at) ASC,
           l.id ASC
  LIMIT 1
  FOR UPDATE OF l;

  IF v_lote_id IS NULL THEN
    RAISE EXCEPTION 'SIN_SALDO_CREDITOS' USING ERRCODE = 'P0001';
  END IF;

  UPDATE lotes_creditos_estudios
  SET cantidad_disponible = cantidad_disponible - 1
  WHERE id = v_lote_id;

  SELECT COALESCE(SUM(cantidad_disponible), 0) INTO v_saldo
  FROM lotes_creditos_estudios
  WHERE perfil_id = p_perfil_id
    AND (vence_en IS NULL OR vence_en > NOW());

  INSERT INTO movimientos_creditos_estudios (
    perfil_id, lote_id, tipo, cantidad, saldo_resultante,
    expediente_id, solicitante_id, pago_id, usuario_id, notas, created_at
  ) VALUES (
    p_perfil_id, v_lote_id, 'reserva', -1, v_saldo,
    p_expediente_id, p_solicitante_id, p_pago_id, p_usuario_id, p_notas, clock_timestamp()
  );

  RETURN QUERY SELECT v_lote_id, v_saldo;
END;
$$ LANGUAGE plpgsql;

REVOKE EXECUTE ON FUNCTION public.consume_credito_estudio(UUID, UUID, UUID, UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consume_credito_estudio(UUID, UUID, UUID, UUID, UUID, TEXT) TO service_role;

-- 5a. Confirmar el consumo (§2.1, desenlace c). Devuelve:
--   'consumido'     la reserva quedó consumida con la consulta que la generó
--   'ya_consumido'  el pago ya tenía su consumo (cascada, re-consulta, co-arrendatario)
--   'sin_saldo'     la reserva se había liberado y ya no hay cupo para volver a tomarla
--   'no_es_credito' el pago no salió de un paquete
CREATE OR REPLACE FUNCTION public.confirmar_consumo_credito(
  p_pago_id UUID,
  p_estudio_id UUID,
  p_referencia TEXT,
  p_usuario_id UUID DEFAULT NULL
)
RETURNS TEXT
SET search_path = public
AS $$
DECLARE
  v_ult RECORD;
  v_lote UUID;
  v_saldo INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('cupo:' || p_pago_id::text, 0));

  SELECT m.tipo::text AS tipo, m.literal, m.lote_id, m.perfil_id, m.expediente_id, m.solicitante_id
  INTO v_ult
  FROM movimientos_creditos_estudios m
  WHERE m.pago_id = p_pago_id AND m.tipo::text IN ('reserva', 'consumo', 'liberacion', 'ajuste')
  ORDER BY m.created_at DESC
  LIMIT 1;

  IF NOT FOUND THEN RETURN 'no_es_credito'; END IF;
  IF v_ult.tipo = 'consumo' AND v_ult.literal = 'c' THEN RETURN 'ya_consumido'; END IF;

  v_lote := v_ult.lote_id;
  IF v_ult.tipo IN ('liberacion', 'ajuste') THEN
    -- La reserva se había liberado y aun así hubo resultado: se toma otro cupo.
    BEGIN
      SELECT r.lote_id INTO v_lote
      FROM public.consume_credito_estudio(v_ult.perfil_id, v_ult.expediente_id, v_ult.solicitante_id, p_pago_id, p_usuario_id,
                                          'Reserva al registrar el resultado de la consulta') r;
    EXCEPTION WHEN raise_exception THEN
      RETURN 'sin_saldo';
    END;
  END IF;

  SELECT COALESCE(SUM(cantidad_disponible), 0) INTO v_saldo
  FROM lotes_creditos_estudios
  WHERE perfil_id = v_ult.perfil_id AND (vence_en IS NULL OR vence_en > NOW());

  INSERT INTO movimientos_creditos_estudios (
    perfil_id, lote_id, tipo, cantidad, saldo_resultante, expediente_id, solicitante_id,
    pago_id, usuario_id, estudio_id, referencia_proveedor, literal, notas, created_at
  ) VALUES (
    v_ult.perfil_id, v_lote, 'consumo', 0, v_saldo, v_ult.expediente_id, v_ult.solicitante_id,
    p_pago_id, p_usuario_id, p_estudio_id, p_referencia, 'c',
    'Consumo: la consulta a centrales produjo resultado (Adenda de precios §2.2 c)', clock_timestamp()
  );
  RETURN 'consumido';
END;
$$ LANGUAGE plpgsql;

REVOKE EXECUTE ON FUNCTION public.confirmar_consumo_credito(UUID, UUID, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirmar_consumo_credito(UUID, UUID, TEXT, UUID) TO service_role;

-- 5b. Liberar la reserva (§2.2 a/b, §2.5). Devuelve:
--   'liberado'      el cupo volvió al mismo lote
--   'a_deuda'       la compra del lote se contracargó: bajó el saldo en contra (P22)
--   'extinguido'    el lote ya venció: el cupo se extingue (§3.1)
--   'consumido'     el pago ya tiene consumo con resultado: no se revierte (§2.4)
--   'ya_liberado'   la reserva ya se había liberado
--   'no_es_credito' el pago no salió de un paquete
CREATE OR REPLACE FUNCTION public.liberar_reserva_credito(
  p_pago_id UUID,
  p_literal TEXT,
  p_estudio_id UUID DEFAULT NULL,
  p_usuario_id UUID DEFAULT NULL,
  p_notas TEXT DEFAULT NULL
)
RETURNS TEXT
SET search_path = public
AS $$
DECLARE
  v_ult RECORD;
  v_lote RECORD;
  v_cantidad INTEGER := 0;
  v_resultado TEXT;
  v_saldo INTEGER;
BEGIN
  IF p_literal NOT IN ('a', 'b', '2.5') THEN
    RAISE EXCEPTION 'LITERAL_INVALIDO' USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('cupo:' || p_pago_id::text, 0));

  SELECT m.tipo::text AS tipo, m.literal, m.lote_id, m.perfil_id, m.expediente_id, m.solicitante_id
  INTO v_ult
  FROM movimientos_creditos_estudios m
  WHERE m.pago_id = p_pago_id AND m.tipo::text IN ('reserva', 'consumo', 'liberacion', 'ajuste')
  ORDER BY m.created_at DESC
  LIMIT 1;

  IF NOT FOUND THEN RETURN 'no_es_credito'; END IF;
  IF v_ult.tipo = 'consumo' AND v_ult.literal = 'c' THEN RETURN 'consumido'; END IF;
  IF v_ult.tipo IN ('liberacion', 'ajuste') THEN RETURN 'ya_liberado'; END IF;
  IF v_ult.lote_id IS NULL THEN
    RAISE EXCEPTION 'RESERVA_SIN_LOTE' USING ERRCODE = 'P0001';
  END IF;

  SELECT l.id, l.vence_en, c.id AS compra_id, c.estado::text AS compra_estado, c.creditos_en_contra
  INTO v_lote
  FROM lotes_creditos_estudios l
  LEFT JOIN compras_creditos_estudios c ON c.id = l.compra_id
  WHERE l.id = v_ult.lote_id
  FOR UPDATE OF l;

  IF v_lote.compra_estado = 'cancelado' AND COALESCE(v_lote.creditos_en_contra, 0) > 0 THEN
    UPDATE compras_creditos_estudios SET creditos_en_contra = creditos_en_contra - 1 WHERE id = v_lote.compra_id;
    v_resultado := 'a_deuda';
  ELSIF v_lote.vence_en IS NOT NULL AND v_lote.vence_en <= NOW() THEN
    v_resultado := 'extinguido';
  ELSE
    UPDATE lotes_creditos_estudios SET cantidad_disponible = cantidad_disponible + 1 WHERE id = v_lote.id;
    v_cantidad := 1;
    v_resultado := 'liberado';
  END IF;

  SELECT COALESCE(SUM(cantidad_disponible), 0) INTO v_saldo
  FROM lotes_creditos_estudios
  WHERE perfil_id = v_ult.perfil_id AND (vence_en IS NULL OR vence_en > NOW());

  INSERT INTO movimientos_creditos_estudios (
    perfil_id, lote_id, tipo, cantidad, saldo_resultante, expediente_id, solicitante_id,
    pago_id, usuario_id, estudio_id, literal, notas, created_at
  ) VALUES (
    v_ult.perfil_id, v_lote.id, 'liberacion', v_cantidad, v_saldo, v_ult.expediente_id, v_ult.solicitante_id,
    p_pago_id, p_usuario_id, p_estudio_id, p_literal,
    CONCAT_WS(' ', p_notas,
      CASE v_resultado
        WHEN 'a_deuda' THEN 'Bajó el saldo en contra de la compra reversada.'
        WHEN 'extinguido' THEN 'El paquete ya venció: el cupo se extingue.'
        ELSE NULL
      END),
    clock_timestamp()
  );
  RETURN v_resultado;
END;
$$ LANGUAGE plpgsql;

REVOKE EXECUTE ON FUNCTION public.liberar_reserva_credito(UUID, TEXT, UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.liberar_reserva_credito(UUID, TEXT, UUID, UUID, TEXT) TO service_role;

-- 5c. Volver a reservar antes de reintentar la consulta de un pago cuya
--     reserva se liberó (falla y reintento = un solo cupo). Devuelve
--     'reservado', 'sin_saldo' o 'no_aplica' (no es crédito o la reserva sigue
--     abierta o ya se consumió).
CREATE OR REPLACE FUNCTION public.reactivar_reserva_credito(
  p_pago_id UUID,
  p_usuario_id UUID DEFAULT NULL
)
RETURNS TEXT
SET search_path = public
AS $$
DECLARE
  v_ult RECORD;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('cupo:' || p_pago_id::text, 0));

  SELECT m.tipo::text AS tipo, m.perfil_id, m.expediente_id, m.solicitante_id
  INTO v_ult
  FROM movimientos_creditos_estudios m
  WHERE m.pago_id = p_pago_id AND m.tipo::text IN ('reserva', 'consumo', 'liberacion', 'ajuste')
  ORDER BY m.created_at DESC
  LIMIT 1;

  IF NOT FOUND OR v_ult.tipo NOT IN ('liberacion', 'ajuste') THEN RETURN 'no_aplica'; END IF;

  BEGIN
    PERFORM public.consume_credito_estudio(v_ult.perfil_id, v_ult.expediente_id, v_ult.solicitante_id, p_pago_id, p_usuario_id,
                                           'Reserva para reintentar la consulta');
  EXCEPTION WHEN raise_exception THEN
    RETURN 'sin_saldo';
  END;
  RETURN 'reservado';
END;
$$ LANGUAGE plpgsql;

REVOKE EXECUTE ON FUNCTION public.reactivar_reserva_credito(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reactivar_reserva_credito(UUID, UUID) TO service_role;

NOTIFY pgrst, 'reload schema';

-- Verificación:
--   SELECT enum_range(NULL::tipo_movimiento_creditos);            -- incluye reserva, liberacion
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'movimientos_creditos_estudios' AND column_name IN ('estudio_id','referencia_proveedor','literal');  -- 3 filas
--   SELECT column_name FROM information_schema.columns WHERE table_name = 'estudios' AND column_name = 'desenlace_consulta';  -- 1 fila
--   SELECT pg_get_functiondef('public.consume_credito_estudio(uuid,uuid,uuid,uuid,uuid,text)'::regprocedure) LIKE '%''reserva''%';  -- true
--   SELECT has_function_privilege('anon', 'public.liberar_reserva_credito(uuid,text,uuid,uuid,text)', 'EXECUTE');  -- false
