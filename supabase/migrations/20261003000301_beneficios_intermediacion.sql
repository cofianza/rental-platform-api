-- ============================================================
-- Adenda de precios v1.0 (29/09/2026) §4.1-4.4, §9.9-9.11
-- ------------------------------------------------------------
-- 1) beneficios_intermediacion: el beneficio del 50 % en modalidad
--    Tradicional, causado cuando el contrato V3 queda vigente (firmaron todas
--    las partes). Se ACUMULA sin liquidar (§4.3): liquidado_en queda NULL
--    hasta que la Gerencia General defina la forma de pago.
--    Un beneficio por estudio y tipo (UNIQUE): causar es idempotente.
--    tipo: hoy solo 'tradicional_50'. Previsto (sin causar, depende del
--    Módulo de Recaudo): 'trasladada_10' (§5.2b, 10 % sobre la tarifa mensual).
-- 2) inmobiliarias.alerta_mezcla_tradicional_en: la última alerta de mezcla
--    (§4.4). Se avisa solo al cruzar el umbral; vuelve a NULL cuando el % baja.
-- RLS habilitada sin políticas: solo la API (service_role).
-- Idempotente.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.beneficios_intermediacion (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inmobiliaria_id UUID NOT NULL REFERENCES public.inmobiliarias(id) ON DELETE RESTRICT,
  expediente_id   UUID NOT NULL REFERENCES public.expedientes(id) ON DELETE RESTRICT,
  contrato_id     UUID NOT NULL REFERENCES public.contratos(id) ON DELETE RESTRICT,
  tipo            TEXT NOT NULL CHECK (tipo IN ('tradicional_50')),
  base_cop        NUMERIC(14,2) NOT NULL CHECK (base_cop > 0),
  pct             NUMERIC(6,2)  NOT NULL CHECK (pct >= 0 AND pct <= 100),
  valor_cop       NUMERIC(14,2) NOT NULL CHECK (valor_cop >= 0),
  -- Origen de la base (§4.1): el lote y la compra si se pagó con crédito; el pago siempre.
  lote_id         UUID REFERENCES public.lotes_creditos_estudios(id) ON DELETE SET NULL,
  compra_id       UUID REFERENCES public.compras_creditos_estudios(id) ON DELETE SET NULL,
  pago_id         UUID REFERENCES public.pagos(id) ON DELETE SET NULL,
  causado_en      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  liquidado_en    TIMESTAMPTZ,
  CONSTRAINT uq_beneficio_expediente_tipo UNIQUE (expediente_id, tipo)
);

CREATE INDEX IF NOT EXISTS idx_beneficios_inmobiliaria
  ON public.beneficios_intermediacion (inmobiliaria_id, causado_en DESC);

ALTER TABLE public.beneficios_intermediacion ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.beneficios_intermediacion FROM anon, authenticated;

COMMENT ON TABLE public.beneficios_intermediacion IS
  'Adenda de precios §4: beneficio de la inmobiliaria causado por estudio (50 % de lo efectivamente pagado sin IVA, solo Tradicional, al quedar vigente el contrato). Se acumula sin liquidar.';

ALTER TABLE public.inmobiliarias
  ADD COLUMN IF NOT EXISTS alerta_mezcla_tradicional_en TIMESTAMPTZ;

COMMENT ON COLUMN public.inmobiliarias.alerta_mezcla_tradicional_en IS
  'Adenda de precios §4.4: cuándo se avisó a la Gerencia General que el % Tradicional superó el umbral. NULL = por debajo (el próximo cruce vuelve a avisar).';
