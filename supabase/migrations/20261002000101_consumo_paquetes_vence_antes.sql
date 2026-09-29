-- ============================================================
-- Adenda de precios v1.0 §3.4 / §9.7 — Orden de consumo de los paquetes
--
-- «Primero el paquete cuya fecha de vencimiento esté más próxima. Si dos
-- vencen el mismo día, primero el de fecha de compra más antigua.»
--
-- Antes: FIFO por fecha de acreditación del lote (created_at), sin mirar
-- vence_en. Ahora: vence_en ASC NULLS LAST (los lotes sin vencimiento,
-- vendidos antes de la Adenda, van al final), luego la fecha de la compra
-- (lote.created_at si el lote no viene de una compra, p. ej. un ajuste) y el
-- id para desempatar de forma estable. El resto del cuerpo es idéntico al de
-- 20260429000001_creditos_estudios.sql (única definición previa).
--
-- La función no es SECURITY DEFINER; igual se fija search_path y se quita
-- EXECUTE a PUBLIC y anon: solo la llama el API con service_role.
--
-- Idempotente (CREATE OR REPLACE). No cambia filas.
-- ============================================================

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
  -- 1. Lote no vencido con saldo que vence antes (Adenda §3.4), con lock
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

  -- 2. Decrementar saldo del lote
  UPDATE lotes_creditos_estudios
  SET cantidad_disponible = cantidad_disponible - 1
  WHERE id = v_lote_id;

  -- 3. Calcular saldo total restante del perfil
  SELECT COALESCE(SUM(cantidad_disponible), 0) INTO v_saldo
  FROM lotes_creditos_estudios
  WHERE perfil_id = p_perfil_id
    AND (vence_en IS NULL OR vence_en > NOW());

  -- 4. Registrar movimiento
  INSERT INTO movimientos_creditos_estudios (
    perfil_id, lote_id, tipo, cantidad, saldo_resultante,
    expediente_id, solicitante_id, pago_id, usuario_id, notas
  ) VALUES (
    p_perfil_id, v_lote_id, 'consumo', -1, v_saldo,
    p_expediente_id, p_solicitante_id, p_pago_id, p_usuario_id, p_notas
  );

  RETURN QUERY SELECT v_lote_id, v_saldo;
END;
$$ LANGUAGE plpgsql;

REVOKE EXECUTE ON FUNCTION public.consume_credito_estudio(UUID, UUID, UUID, UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consume_credito_estudio(UUID, UUID, UUID, UUID, UUID, TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';

-- Verificación:
--   SELECT pg_get_functiondef('public.consume_credito_estudio(uuid,uuid,uuid,uuid,uuid,text)'::regprocedure) LIKE '%NULLS LAST%';
--   -- true
--   SELECT has_function_privilege('anon', 'public.consume_credito_estudio(uuid,uuid,uuid,uuid,uuid,text)', 'EXECUTE');
--   -- false
