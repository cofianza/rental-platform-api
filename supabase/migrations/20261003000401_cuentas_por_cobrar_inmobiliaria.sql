-- ============================================================
-- Adenda de precios v1.0 §5.1 y §5.3: prima de vinculación en modalidad
-- Trasladada como cuenta por cobrar a la inmobiliaria.
--
-- La inmobiliaria recauda la prima del arrendatario por cuenta de Cofianza y
-- la remite el día 10 (el del recaudo general). La API crea la fila al activar
-- el contrato (firma V3 completa), con el monto con IVA del contrato firmado y
-- la fecha límite; un operador la marca 'remitida'. El barrido del reporte
-- (PRIMA_REPORTE_REMISION_ENABLED) deja reporte_enviado_en para no repetirlo.
--
-- Solo SUMA una tabla. Idempotente. RLS habilitada SIN políticas: solo la API
-- (service_role) la lee y escribe.
--
-- Verificación:
--   SELECT relrowsecurity FROM pg_class WHERE oid = 'public.cuentas_por_cobrar_inmobiliaria'::regclass; -- true
--   SELECT count(*) FROM pg_policies WHERE tablename = 'cuentas_por_cobrar_inmobiliaria';               -- 0
-- ============================================================
CREATE TABLE IF NOT EXISTS public.cuentas_por_cobrar_inmobiliaria (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inmobiliaria_id     uuid NOT NULL REFERENCES public.inmobiliarias(id),
  contrato_id         uuid NOT NULL REFERENCES public.contratos(id),
  concepto            text NOT NULL CHECK (concepto IN ('prima_trasladada')),
  monto_cop           integer NOT NULL CHECK (monto_cop >= 0),
  vence_en            date NOT NULL,
  estado              text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'remitida', 'anulada')),
  remitida_en         timestamptz,
  remitida_por        uuid REFERENCES public.perfiles(id),
  notas               text,
  reporte_enviado_en  timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cuentas_por_cobrar_inmobiliaria_contrato_concepto_key UNIQUE (contrato_id, concepto)
);

CREATE INDEX IF NOT EXISTS idx_cxc_inmobiliaria_pendientes
  ON public.cuentas_por_cobrar_inmobiliaria (vence_en)
  WHERE estado = 'pendiente';

ALTER TABLE public.cuentas_por_cobrar_inmobiliaria ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cuentas_por_cobrar_inmobiliaria FROM anon, authenticated;

COMMENT ON TABLE public.cuentas_por_cobrar_inmobiliaria IS
  'Adenda de precios §5.1: lo que la inmobiliaria recauda por cuenta de Cofianza (prima Trasladada) y debe remitir el día 10.';
COMMENT ON COLUMN public.cuentas_por_cobrar_inmobiliaria.monto_cop IS 'Con IVA, el del contrato firmado. Sin beneficio ni descuento (Adenda de precios §5.2).';
COMMENT ON COLUMN public.cuentas_por_cobrar_inmobiliaria.reporte_enviado_en IS 'Adenda de precios §5.3: cuándo salió el reporte (10 días antes de vence_en).';
