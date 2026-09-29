-- ============================================================
-- Adenda de precios v1.0 §3.1 / §3.9 — Extinción de los cupos vencidos
--
-- §3.1 «Vencido el plazo, los cupos no usados se extinguen.»
-- §3.9 «Reporte mensual de cupos vencidos … para su registro contable.»
--
-- El saldo y el consumo ya ignoraban los lotes vencidos, pero nadie dejaba
-- constancia: el lote seguía con cantidad_disponible > 0 y no había
-- movimiento 'expiracion' que reportar. Esta migración:
--
--   1. extinguir_lote_vencido(lote): deja en 0 un lote vencido con saldo y
--      registra un movimiento 'expiracion' por lo que tenía (cantidad
--      negativa). Idempotente: con el lote bloqueado (FOR UPDATE) solo actúa
--      si sigue vencido y con saldo; la segunda llamada no hace nada. No toca
--      las reservas abiertas (ya salieron del lote). La llama el barrido
--      diario del API (CUPOS_VENCIMIENTO_ENABLED).
--   2. liberar_reserva_credito: cuando la reserva vuelve a un lote que ya
--      venció (resultado 'extinguido'), la liberación registra el regreso
--      (+1) y a continuación un 'expiracion' (-1) inmediato, para que ese
--      cupo también aparezca en el reporte de vencidos. Antes quedaba solo la
--      liberación con cantidad 0. El resto del cuerpo es idéntico al de
--      20261003000001_consumo_cupo_reserva.sql.
--
-- Ninguna función es SECURITY DEFINER; igual se fija search_path y se quita
-- EXECUTE a PUBLIC y anon: solo las llama el API con service_role.
--
-- ORDEN: después de 20261003000001_consumo_cupo_reserva.sql y ANTES de
-- desplegar la API de esta rama (el barrido llama la RPC nueva).
--
-- Idempotente: CREATE OR REPLACE. No cambia filas existentes (las extingue
-- el barrido cuando se enciende).
-- ============================================================

-- Para el reporte mensual (§3.9): los 'expiracion' por fecha.
CREATE INDEX IF NOT EXISTS idx_movimientos_creditos_expiracion
  ON movimientos_creditos_estudios(created_at) WHERE tipo = 'expiracion';

-- 1. Extinguir un lote vencido
CREATE OR REPLACE FUNCTION public.extinguir_lote_vencido(p_lote_id UUID)
RETURNS TABLE(lote_perfil_id UUID, extinguidos INTEGER, saldo_restante INTEGER)
SET search_path = public
AS $$
DECLARE
  v_lote RECORD;
  v_saldo INTEGER;
BEGIN
  SELECT l.id, l.perfil_id, l.cantidad_disponible INTO v_lote
  FROM lotes_creditos_estudios l
  WHERE l.id = p_lote_id
    AND l.vence_en IS NOT NULL
    AND l.vence_en <= NOW()
    AND l.cantidad_disponible > 0
  FOR UPDATE;

  IF NOT FOUND THEN RETURN; END IF;  -- no venció, no tiene saldo o ya se extinguió

  UPDATE lotes_creditos_estudios SET cantidad_disponible = 0 WHERE id = v_lote.id;

  SELECT COALESCE(SUM(l.cantidad_disponible), 0) INTO v_saldo
  FROM lotes_creditos_estudios l
  WHERE l.perfil_id = v_lote.perfil_id AND (l.vence_en IS NULL OR l.vence_en > NOW());

  INSERT INTO movimientos_creditos_estudios (
    perfil_id, lote_id, tipo, cantidad, saldo_resultante, notas, created_at
  ) VALUES (
    v_lote.perfil_id, v_lote.id, 'expiracion', -v_lote.cantidad_disponible, v_saldo,
    'Vencimiento del paquete: los cupos no usados se extinguen (Adenda de precios §3.1).', clock_timestamp()
  );

  RETURN QUERY SELECT v_lote.perfil_id, v_lote.cantidad_disponible, v_saldo;
END;
$$ LANGUAGE plpgsql;

REVOKE EXECUTE ON FUNCTION public.extinguir_lote_vencido(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.extinguir_lote_vencido(UUID) TO service_role;

-- 2. Liberar la reserva: la vuelta a un lote vencido se extingue con constancia
-- Devuelve:
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
    v_cantidad := 1;  -- vuelve y se extingue en el 'expiracion' de abajo (§3.1)
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

  IF v_resultado = 'extinguido' THEN
    INSERT INTO movimientos_creditos_estudios (
      perfil_id, lote_id, tipo, cantidad, saldo_resultante, expediente_id, solicitante_id,
      pago_id, usuario_id, estudio_id, notas, created_at
    ) VALUES (
      v_ult.perfil_id, v_lote.id, 'expiracion', -1, v_saldo, v_ult.expediente_id, v_ult.solicitante_id,
      p_pago_id, p_usuario_id, p_estudio_id,
      'El cupo volvió a un paquete vencido y se extingue (Adenda de precios §3.1).', clock_timestamp()
    );
  END IF;
  RETURN v_resultado;
END;
$$ LANGUAGE plpgsql;

REVOKE EXECUTE ON FUNCTION public.liberar_reserva_credito(UUID, TEXT, UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.liberar_reserva_credito(UUID, TEXT, UUID, UUID, TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';

-- Verificación:
--   SELECT has_function_privilege('anon', 'public.extinguir_lote_vencido(uuid)', 'EXECUTE');  -- false
--   SELECT pg_get_functiondef('public.liberar_reserva_credito(uuid,text,uuid,uuid,text)'::regprocedure) LIKE '%''expiracion'', -1%';  -- true
--   Lotes que el barrido extinguirá al encenderse:
--   SELECT count(*), sum(cantidad_disponible) FROM lotes_creditos_estudios
--    WHERE vence_en <= now() AND cantidad_disponible > 0;
