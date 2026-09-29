-- ============================================================
-- Adenda de precios v1.0 (29/09/2026) §1.1-1.4, §3.5 (IVA), §9.1-9.5
-- ------------------------------------------------------------
-- 1) PRECIO_ESTUDIO_INDIVIDUAL pasa a calibración (nivel riesgo: solo la
--    Gerencia General lo cambia, con historial). Se siembra con lo que hoy
--    vale configuracion_sistema.monto_estudio (80.000 si no existe). Es la
--    BASE sin IVA; el cobro es base + TARIFA_IVA (80.000 -> 95.200).
-- 2) Instantánea del IVA en cada pago y en cada compra de paquete: la factura
--    DIAN se emite con la base y la tasa con las que se cobró, no con las de
--    hoy. Filas viejas quedan en NULL = se facturan como antes (exento).
-- Idempotente.
-- ============================================================

INSERT INTO public.parametros_calibracion (clave, valor, descripcion)
SELECT
  'PRECIO_ESTUDIO_INDIVIDUAL',
  -- Se lee como lo leía la API (parseInt): '80000.00' es 80000, no 8000000.
  -- Fuera del rango de calibración (1.000-10.000.000), el default.
  COALESCE(
    (SELECT v FROM (
       SELECT substring(valor FROM '^\s*(\d+)')::numeric AS v
         FROM public.configuracion_sistema WHERE clave = 'monto_estudio'
     ) s WHERE v BETWEEN 1000 AND 10000000),
    80000
  ),
  'Adenda de precios §1.1 / §9.1 — precio base del estudio individual (COP, sin IVA). Se cobra más TARIFA_IVA.'
ON CONFLICT (clave) DO NOTHING;

ALTER TABLE public.pagos
  ADD COLUMN IF NOT EXISTS base_cop   NUMERIC(14,2) CHECK (base_cop IS NULL OR base_cop >= 0),
  ADD COLUMN IF NOT EXISTS iva_cop    NUMERIC(14,2) CHECK (iva_cop IS NULL OR iva_cop >= 0),
  ADD COLUMN IF NOT EXISTS tarifa_iva NUMERIC(6,2)  CHECK (tarifa_iva IS NULL OR (tarifa_iva >= 0 AND tarifa_iva <= 100));

COMMENT ON COLUMN public.pagos.base_cop IS
  'Adenda de precios §1.1: base sin IVA del cobro (monto = base_cop + iva_cop). NULL = cobro anterior a la adenda, se factura como exento.';
COMMENT ON COLUMN public.pagos.tarifa_iva IS
  'TARIFA_IVA (%) vigente al crear el cobro; la factura usa esta, no la de hoy.';

ALTER TABLE public.compras_creditos_estudios
  ADD COLUMN IF NOT EXISTS iva_cop    NUMERIC(14,2) CHECK (iva_cop IS NULL OR iva_cop >= 0),
  ADD COLUMN IF NOT EXISTS total_cop  NUMERIC(14,2) CHECK (total_cop IS NULL OR total_cop >= 0),
  ADD COLUMN IF NOT EXISTS tarifa_iva NUMERIC(6,2)  CHECK (tarifa_iva IS NULL OR (tarifa_iva >= 0 AND tarifa_iva <= 100));

COMMENT ON COLUMN public.compras_creditos_estudios.total_cop IS
  'Adenda de precios §1.1: lo cobrado = precio_cop (base) + iva_cop. NULL = compra anterior a la adenda (se cobró precio_cop y se factura como antes).';
