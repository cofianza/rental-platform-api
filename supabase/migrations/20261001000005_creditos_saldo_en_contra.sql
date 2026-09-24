-- ============================================================
-- P22 (decisiones 2026-09-24) — Saldo en contra de créditos de estudio
--
-- Si Mercado Pago contracarga o reembolsa una compra de créditos, el API
-- retira los créditos que no se usaron y deja los ya usados como saldo en
-- contra de la organización: bloquea solo pagar evaluaciones con créditos
-- (pagar de inmediato y el enlace al prospecto siguen) y se descuenta de la
-- próxima compra. La cuenta no se bloquea (Adenda 2 §7: Cofianza no le da
-- crédito a las inmobiliarias). Esta columna guarda, en la compra
-- contracargada, cuántos créditos usados falta cubrir.
--
-- El API funciona antes y después: sin la columna, un contracargo igual retira
-- los créditos no usados y le avisa al administrador que descuente los usados
-- a mano; nadie queda bloqueado.
--
-- Idempotente. No cambia filas existentes (default 0).
-- ============================================================

ALTER TABLE public.compras_creditos_estudios
  ADD COLUMN IF NOT EXISTS creditos_en_contra INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'compras_creditos_en_contra_no_negativo') THEN
    ALTER TABLE public.compras_creditos_estudios
      ADD CONSTRAINT compras_creditos_en_contra_no_negativo CHECK (creditos_en_contra >= 0);
  END IF;
END $$;

COMMENT ON COLUMN public.compras_creditos_estudios.creditos_en_contra IS
  'P22: créditos ya usados de una compra contracargada o reembolsada que todavía no cubre una compra nueva (saldo en contra). Mientras la suma de la organización sea mayor que 0 no se paga con créditos.';

-- Que PostgREST vea la columna nueva sin esperar.
NOTIFY pgrst, 'reload schema';

-- Verificación:
--   SELECT column_name, data_type, column_default, is_nullable FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'compras_creditos_estudios' AND column_name = 'creditos_en_contra';
--   -- creditos_en_contra | integer | 0 | NO
--   SELECT count(*) FROM compras_creditos_estudios WHERE creditos_en_contra <> 0;
--   -- 0 al correrla
--
-- ROLLBACK (solo si no hay contracargos registrados):
--   ALTER TABLE public.compras_creditos_estudios DROP CONSTRAINT IF EXISTS compras_creditos_en_contra_no_negativo;
--   ALTER TABLE public.compras_creditos_estudios DROP COLUMN IF EXISTS creditos_en_contra;
