-- ============================================================
-- Cobro automático de la tarifa mensual de la fianza
-- (plan migracion/plan-cobro-tarifa-mensual.md §2, decisiones D1-D16).
--
-- 1. cuentas_cobro_tarifa: una cuenta de cobro por inmobiliaria y mes (corte el
--    último día de M-1, vence el día 10 de M). «Pagada», «parcial» y «vencida»
--    NO son estados: se derivan de las líneas.
-- 2. cuentas_cobro_tarifa_lineas: una línea por contrato y período, con el
--    cálculo congelado (canon, %, días, IVA de ese día). Trasladada va en la
--    cuenta pero no en la factura (facturable = false, D13).
-- 3. contrato_condiciones_cobro: canon reajustado (D9), otrosí de tarifa (solo
--    Gerencia) y % congelado de los contratos sin tarifa_congelada (D2).
-- 4. contratos.fecha_terminacion_efectiva: prevalece sobre fecha_terminacion (A5).
-- 5. facturas.cuenta_cobro_id: tercer ancla de la factura (facturas_anchor_chk).
-- 6. Trigger que congela las líneas de una cuenta que ya salió de borrador:
--    lo que se factura y los totales siempre cuadran con las líneas.
--
-- Solo SUMA columnas y tablas; no escribe datos existentes. Re-ejecutable
-- (IF NOT EXISTS / DROP ... IF EXISTS / CREATE OR REPLACE). Crea una sola
-- función, de trigger (no SECURITY DEFINER, sin EXECUTE para anon ni
-- authenticated). No crea valores de enum.
-- Tablas nuevas con RLS habilitada SIN políticas y sin privilegios para anon ni
-- authenticated: solo la API (service_role) las lee y escribe.
--
-- Verificación (solo lectura, después de correrla):
--   SELECT relname, relrowsecurity FROM pg_class
--    WHERE relname IN ('cuentas_cobro_tarifa', 'cuentas_cobro_tarifa_lineas', 'contrato_condiciones_cobro')
--      AND relkind = 'r';                                                      -- 3 filas, todas true
--   SELECT count(*) FROM pg_policies
--    WHERE tablename IN ('cuentas_cobro_tarifa', 'cuentas_cobro_tarifa_lineas', 'contrato_condiciones_cobro'); -- 0
--   SELECT has_table_privilege('anon', 'public.cuentas_cobro_tarifa', 'SELECT'),
--          has_table_privilege('authenticated', 'public.cuentas_cobro_tarifa_lineas', 'SELECT'); -- false, false
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'facturas_anchor_chk';
--   -- esperado: CHECK (pago_id IS NOT NULL OR compra_creditos_id IS NOT NULL OR cuenta_cobro_id IS NOT NULL)
--   SELECT tgname FROM pg_trigger WHERE tgname = 'cuentas_cobro_tarifa_lineas_congeladas'; -- 1 fila
--
-- ROLLBACK (manual, solo si no hay cuentas emitidas):
--   ALTER TABLE public.facturas DROP CONSTRAINT IF EXISTS facturas_anchor_chk;
--   ALTER TABLE public.facturas ADD CONSTRAINT facturas_anchor_chk
--     CHECK (pago_id IS NOT NULL OR compra_creditos_id IS NOT NULL);
--   ALTER TABLE public.facturas DROP COLUMN IF EXISTS cuenta_cobro_id;
--   DROP FUNCTION IF EXISTS public.cuentas_cobro_tarifa_lineas_congeladas() CASCADE;
--   DROP TABLE IF EXISTS public.cuentas_cobro_tarifa_lineas, public.cuentas_cobro_tarifa,
--     public.contrato_condiciones_cobro;
--   ALTER TABLE public.contratos DROP COLUMN IF EXISTS fecha_terminacion_efectiva;
-- ============================================================

BEGIN;

-- ── 1. Cuentas de cobro ──

CREATE TABLE IF NOT EXISTS public.cuentas_cobro_tarifa (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inmobiliaria_id       UUID NOT NULL REFERENCES public.inmobiliarias(id),
  periodo               DATE NOT NULL CHECK (periodo = date_trunc('month', periodo)::date),
  vence_en              DATE NOT NULL,
  estado                TEXT NOT NULL DEFAULT 'borrador'
                          CHECK (estado IN ('borrador', 'bloqueada_fiscal', 'emitiendo', 'emitida', 'anulada')),
  -- Se recalculan desde las líneas mientras la cuenta está en borrador; se congelan al emitir.
  base_cop              INTEGER NOT NULL DEFAULT 0 CHECK (base_cop >= 0),
  iva_cop               NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (iva_cop >= 0),
  cash_rounding_cop     NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_cop             INTEGER NOT NULL DEFAULT 0 CHECK (total_cop >= 0),
  -- Copia fiscal del titular al emitir (D14: persona jurídica, NIT obligatorio).
  cliente_nit           TEXT,
  cliente_razon_social  TEXT,
  cliente_email         TEXT,
  cliente_direccion     TEXT,
  factura_id            UUID REFERENCES public.facturas(id) ON DELETE SET NULL,
  emitida_en            TIMESTAMPTZ,
  recordatorio_n        SMALLINT NOT NULL DEFAULT 0 CHECK (recordatorio_n >= 0),
  ultimo_recordatorio_en TIMESTAMPTZ,
  notas                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cuentas_cobro_tarifa_org_periodo_uq UNIQUE (inmobiliaria_id, periodo),
  CONSTRAINT cuentas_cobro_tarifa_emitida_chk CHECK (estado <> 'emitida' OR emitida_en IS NOT NULL)
);

-- Recordatorios de atraso (B6): solo las emitidas.
CREATE INDEX IF NOT EXISTS idx_cuentas_cobro_tarifa_emitidas
  ON public.cuentas_cobro_tarifa (vence_en)
  WHERE estado = 'emitida';

COMMENT ON TABLE public.cuentas_cobro_tarifa IS
  'Cuenta de cobro mensual de la tarifa de la fianza a una inmobiliaria (Adenda de precios §5.3: corte último día de M-1, vence día 10 de M). Pagada/parcial/vencida se derivan de las líneas.';
COMMENT ON COLUMN public.cuentas_cobro_tarifa.periodo IS 'Día 1 del mes liquidado (M).';
COMMENT ON COLUMN public.cuentas_cobro_tarifa.cash_rounding_cop IS 'Ajuste al peso de la factura: el IVA va con centavos por línea y se redondea una sola vez (como partirTotalConIva).';

-- ── 2. Líneas ──

CREATE TABLE IF NOT EXISTS public.cuentas_cobro_tarifa_lineas (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cuenta_id             UUID NOT NULL REFERENCES public.cuentas_cobro_tarifa(id),
  contrato_id           UUID NOT NULL REFERENCES public.contratos(id),
  -- Puede ser anterior al de la cuenta: una activación tardía va al borrador más reciente (D7).
  periodo               DATE NOT NULL CHECK (periodo = date_trunc('month', periodo)::date),
  modalidad             TEXT NOT NULL CHECK (modalidad IN ('tradicional', 'trasladada')),
  origen                TEXT NOT NULL CHECK (origen IN ('plataforma', 'migracion')),
  facturable            BOOLEAN NOT NULL,
  -- Cálculo congelado (D1: base = canon sin IVA × %; IVA vigente el día de la liquidación).
  pct                   NUMERIC(5,2) NOT NULL CHECK (pct >= 0),
  canon_base            NUMERIC(12,2) NOT NULL CHECK (canon_base >= 0),
  dias                  SMALLINT NOT NULL CHECK (dias BETWEEN 1 AND 31),
  dias_mes              SMALLINT NOT NULL CHECK (dias_mes BETWEEN 28 AND 31),
  base_cop              INTEGER NOT NULL CHECK (base_cop >= 0),
  iva_pct               NUMERIC(5,2) NOT NULL CHECK (iva_pct >= 0),
  iva_cop               NUMERIC(14,2) NOT NULL CHECK (iva_cop >= 0),
  total_cop             NUMERIC(14,2) NOT NULL CHECK (total_cop >= 0),
  estado                TEXT NOT NULL DEFAULT 'pendiente'
                          CHECK (estado IN ('pendiente', 'pagada', 'no_recaudada', 'anulada')),
  -- Pago (D12: la fecha de pago queda para liquidar después el cashback).
  pagada_en             DATE,
  referencia_pago       TEXT,
  comprobante_key       TEXT,
  marcada_por           UUID REFERENCES public.perfiles(id) ON DELETE SET NULL,
  -- Anulación.
  anulada_motivo        TEXT,
  requiere_nota_credito BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cuentas_cobro_tarifa_lineas_dias_chk CHECK (dias <= dias_mes),
  CONSTRAINT cuentas_cobro_tarifa_lineas_trasladada_chk CHECK (modalidad = 'tradicional' OR NOT facturable),
  CONSTRAINT cuentas_cobro_tarifa_lineas_pagada_chk CHECK (estado <> 'pagada' OR pagada_en IS NOT NULL),
  CONSTRAINT cuentas_cobro_tarifa_lineas_anulada_chk CHECK (estado <> 'anulada' OR anulada_motivo IS NOT NULL),
  CONSTRAINT cuentas_cobro_tarifa_lineas_no_recaudada_chk CHECK (estado <> 'no_recaudada' OR modalidad = 'trasladada')
);

-- Una sola línea viva por contrato y mes; anulada, se puede volver a liquidar (A4).
CREATE UNIQUE INDEX IF NOT EXISTS uq_cuentas_cobro_tarifa_lineas_contrato_periodo
  ON public.cuentas_cobro_tarifa_lineas (contrato_id, periodo)
  WHERE estado <> 'anulada';
CREATE INDEX IF NOT EXISTS idx_cuentas_cobro_tarifa_lineas_cuenta
  ON public.cuentas_cobro_tarifa_lineas (cuenta_id);

COMMENT ON TABLE public.cuentas_cobro_tarifa_lineas IS
  'Una línea por contrato y mes de la cuenta de cobro de la tarifa. Primer mes proporcional (D4), mes de terminación completo (D5). Trasladada: facturable = false (D13).';

-- ── 3. Condiciones de cobro por contrato ──

CREATE TABLE IF NOT EXISTS public.contrato_condiciones_cobro (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contrato_id     UUID NOT NULL REFERENCES public.contratos(id),
  desde           DATE NOT NULL,
  canon_cop       NUMERIC(12,2) CHECK (canon_cop IS NULL OR canon_cop > 0),
  tarifa_pct      NUMERIC(5,2) CHECK (tarifa_pct IS NULL OR tarifa_pct >= 0),
  soporte_key     TEXT,
  -- NULL = la fijó el sistema (% congelado en la primera línea, D2).
  registrado_por  UUID REFERENCES public.perfiles(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT contrato_condiciones_cobro_contrato_desde_uq UNIQUE (contrato_id, desde),
  CONSTRAINT contrato_condiciones_cobro_algo_chk CHECK (canon_cop IS NOT NULL OR tarifa_pct IS NOT NULL)
);

COMMENT ON TABLE public.contrato_condiciones_cobro IS
  'Canon reajustado (D9) y % de la tarifa (otrosí de Gerencia, o congelado en el primer período cobrado, D2). Rige la última fila con desde <= día 1 del mes.';

-- ── 4. Terminación efectiva ──

ALTER TABLE public.contratos
  ADD COLUMN IF NOT EXISTS fecha_terminacion_efectiva DATE;

COMMENT ON COLUMN public.contratos.fecha_terminacion_efectiva IS
  'Fecha real de terminación registrada por Cofianza; prevalece sobre fecha_terminacion (que es la del registro) para el cobro de la tarifa.';

-- ── 5. Factura de una cuenta de cobro ──

ALTER TABLE public.facturas
  ADD COLUMN IF NOT EXISTS cuenta_cobro_id UUID REFERENCES public.cuentas_cobro_tarifa(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_facturas_cuenta_cobro
  ON public.facturas (cuenta_cobro_id)
  WHERE cuenta_cobro_id IS NOT NULL;

ALTER TABLE public.facturas DROP CONSTRAINT IF EXISTS facturas_anchor_chk;
ALTER TABLE public.facturas
  ADD CONSTRAINT facturas_anchor_chk
    CHECK (pago_id IS NOT NULL OR compra_creditos_id IS NOT NULL OR cuenta_cobro_id IS NOT NULL);

COMMENT ON COLUMN public.facturas.cuenta_cobro_id IS
  'FK a cuentas_cobro_tarifa cuando la factura es la de la tarifa mensual de una inmobiliaria.';

-- ── 6. Líneas congeladas fuera de borrador ──
-- Mientras la cuenta se emite (emitiendo) sus líneas no cambian; emitida o
-- anulada, solo cambian el estado, el pago, la anulación y la marca de nota
-- crédito, nunca el cálculo; y no recibe líneas nuevas. FOR SHARE espera a la
-- transición borrador → emitiendo en curso (y la emisión, a esta escritura).
-- P0T01 lo traduce la API a 409 CUENTA_COBRO_CONGELADA; el barrido lo salta.

CREATE OR REPLACE FUNCTION public.cuentas_cobro_tarifa_lineas_congeladas()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_estado TEXT;
BEGIN
  SELECT estado INTO v_estado FROM public.cuentas_cobro_tarifa
   WHERE id = CASE WHEN TG_OP = 'INSERT' THEN NEW.cuenta_id ELSE OLD.cuenta_id END
   FOR SHARE;
  -- La API nunca mueve una línea de cuenta (cuenta_id): no se revisa la de destino.
  IF v_estado IN ('borrador', 'bloqueada_fiscal') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' OR v_estado = 'emitiendo'
     OR (NEW.cuenta_id, NEW.contrato_id, NEW.periodo, NEW.modalidad, NEW.origen, NEW.facturable, NEW.pct, NEW.canon_base,
         NEW.dias, NEW.dias_mes, NEW.base_cop, NEW.iva_pct, NEW.iva_cop, NEW.total_cop)
        IS DISTINCT FROM
        (OLD.cuenta_id, OLD.contrato_id, OLD.periodo, OLD.modalidad, OLD.origen, OLD.facturable, OLD.pct, OLD.canon_base,
         OLD.dias, OLD.dias_mes, OLD.base_cop, OLD.iva_pct, OLD.iva_cop, OLD.total_cop) THEN
    RAISE EXCEPTION 'La cuenta de cobro ya se está emitiendo o fue emitida: sus líneas no se pueden cambiar' USING ERRCODE = 'P0T01';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.cuentas_cobro_tarifa_lineas_congeladas() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS cuentas_cobro_tarifa_lineas_congeladas ON public.cuentas_cobro_tarifa_lineas;
CREATE TRIGGER cuentas_cobro_tarifa_lineas_congeladas
  BEFORE INSERT OR UPDATE ON public.cuentas_cobro_tarifa_lineas
  FOR EACH ROW EXECUTE FUNCTION public.cuentas_cobro_tarifa_lineas_congeladas();

-- ── updated_at + RLS sin políticas en las tablas nuevas ──

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['cuentas_cobro_tarifa', 'cuentas_cobro_tarifa_lineas'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_updated_at', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION update_updated_at()',
                   t || '_updated_at', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['cuentas_cobro_tarifa', 'cuentas_cobro_tarifa_lineas', 'contrato_condiciones_cobro'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;

COMMIT;
