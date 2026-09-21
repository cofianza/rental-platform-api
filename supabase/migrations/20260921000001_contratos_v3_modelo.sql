-- ============================================================
-- Contratos V3 — Entrega 1: destinacion, IVA del canon, dos bases, partes.
-- Nota de envio del modulo de contratos (Gerencia, 21/09/2026) §3.
-- Aditiva: la API de Entrega 1 no lee ni escribe esto; el flujo legacy
-- (V1/V4) sigue igual y sus filas quedan con destinacion NULL.
-- Control de acceso en capa de aplicacion (service_role bypassa RLS).
-- ============================================================

ALTER TABLE public.contratos
  ADD COLUMN IF NOT EXISTS destinacion   VARCHAR(12),
  ADD COLUMN IF NOT EXISTS iva_canon_pct NUMERIC(5,2);

ALTER TABLE public.contratos
  ADD COLUMN IF NOT EXISTS base_calculo_fianza_cop NUMERIC(14,2)
  GENERATED ALWAYS AS (valor_arriendo + round(valor_arriendo * iva_canon_pct / 100)) STORED;

ALTER TABLE public.contratos DROP CONSTRAINT IF EXISTS contratos_destinacion_chk;
ALTER TABLE public.contratos ADD CONSTRAINT contratos_destinacion_chk
  CHECK (destinacion IN ('vivienda','comercial'));

ALTER TABLE public.contratos DROP CONSTRAINT IF EXISTS contratos_iva_canon_chk;
ALTER TABLE public.contratos ADD CONSTRAINT contratos_iva_canon_chk CHECK (
  (destinacion IS NULL) = (iva_canon_pct IS NULL)
  AND (iva_canon_pct IS NULL OR iva_canon_pct BETWEEN 0 AND 100)
  AND (destinacion IS DISTINCT FROM 'vivienda' OR iva_canon_pct = 0)
);

COMMENT ON COLUMN public.contratos.valor_arriendo IS
  'Canon mensual SIN IVA. Base de cobertura (tope de 18 canones) en toda destinacion (Complemento comercial §4.2).';
COMMENT ON COLUMN public.contratos.destinacion IS
  'Flujo con que se genero el contrato (vivienda|comercial), resuelto de inmuebles.uso al generar; no es espejo de uso. NULL = contrato legacy V1/V4. Todo contrato V3 lo escribe explicito.';
COMMENT ON COLUMN public.contratos.iva_canon_pct IS
  'IVA (%) sobre el canon, congelado al generar. Vivienda = 0 siempre (CHECK). NULL solo en legacy.';
COMMENT ON COLUMN public.contratos.base_calculo_fianza_cop IS
  'Canon + IVA del canon: base de prima y tarifa (Complemento comercial §4.1). 4.000.000 al 19% = 4.760.000. NUNCA alterar la expresion: recalcularia contratos firmados; si la regla cambia, columna nueva.';

CREATE TABLE IF NOT EXISTS public.contrato_partes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contrato_id         UUID NOT NULL REFERENCES public.contratos(id) ON DELETE CASCADE,
  rol                 VARCHAR(15) NOT NULL,
  orden               SMALLINT NOT NULL,
  tipo_persona        public.tipo_persona NOT NULL DEFAULT 'natural',
  nombre              VARCHAR(300) NOT NULL,
  tipo_documento      public.tipo_documento_id NOT NULL,
  numero_documento    VARCHAR(30) NOT NULL,
  digito_verificacion VARCHAR(2),
  representante_legal_nombre         VARCHAR(200),
  representante_legal_tipo_documento public.tipo_documento_id,
  representante_legal_documento      VARCHAR(30),
  matricula_numero       VARCHAR(40),
  matricula_expedida_por VARCHAR(150),
  email      VARCHAR(255),
  telefono   VARCHAR(20),
  direccion  VARCHAR(300),
  municipio  VARCHAR(120),
  estudio_id UUID REFERENCES public.estudios(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT contrato_partes_rol_chk
    CHECK (rol IN ('arrendatario','coarrendatario','arrendador')),
  CONSTRAINT contrato_partes_orden_chk
    CHECK (orden >= 1 AND (rol = 'arrendatario') = (orden = 1)),
  CONSTRAINT contrato_partes_juridica_chk CHECK (tipo_persona = 'natural' OR (
    tipo_documento = 'nit' AND representante_legal_nombre IS NOT NULL
    AND representante_legal_documento IS NOT NULL)),
  CONSTRAINT contrato_partes_orden_uq     UNIQUE (contrato_id, orden),
  CONSTRAINT contrato_partes_documento_uq UNIQUE (contrato_id, tipo_documento, numero_documento)
);
CREATE UNIQUE INDEX IF NOT EXISTS contrato_partes_rol_unico_uq
  ON public.contrato_partes (contrato_id, rol) WHERE rol <> 'coarrendatario';
DROP TRIGGER IF EXISTS contrato_partes_updated_at ON public.contrato_partes;
CREATE TRIGGER contrato_partes_updated_at BEFORE UPDATE ON public.contrato_partes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
ALTER TABLE public.contrato_partes ENABLE ROW LEVEL SECURITY;  -- datos personales; sin policies = solo service_role

COMMENT ON TABLE public.contrato_partes IS
  'Partes del contrato V3: una fila = un bloque de firma (V3 §6.3-6.6; Complemento §10.2-10.3). orden = orden de firma: arrendatario 1, coarrendatarios, arrendador al final (V3 §6.5). Snapshot congelado al generar, no se relee de solicitantes/perfiles. Distinta de contrato_firmantes (estado del sobre Auco, se reinserta en cada envio). Legacy V1/V4 no tiene filas.';
COMMENT ON COLUMN public.contrato_partes.nombre IS 'Natural: nombre completo. Juridica: razon social.';
COMMENT ON COLUMN public.contrato_partes.matricula_numero IS
  'Arrendador: matricula de arrendador. Arrendatario comercial: matricula mercantil del establecimiento (Complemento §3.1.3).';
COMMENT ON COLUMN public.contrato_partes.estudio_id IS 'Evaluacion que cubre a esta persona (Complemento §5.4).';

-- ROLLBACK (manual, no se ejecuta aqui):
--   DROP TABLE IF EXISTS public.contrato_partes;
--   ALTER TABLE public.contratos DROP COLUMN IF EXISTS base_calculo_fianza_cop;
--   ALTER TABLE public.contratos DROP COLUMN IF EXISTS iva_canon_pct;
--   ALTER TABLE public.contratos DROP COLUMN IF EXISTS destinacion;
