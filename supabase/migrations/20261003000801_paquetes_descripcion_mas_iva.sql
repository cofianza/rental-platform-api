-- ============================================================
-- Adenda de precios §1.1-1.2: los precios de los paquetes son la base SIN
-- IVA. La descripción del catálogo decía «$70.000 c/u» sin aclararlo; ahora
-- dice «+ IVA c/u». Solo cambia el texto. Idempotente: toca la fila solo si
-- conserva el texto de la siembra (20260429000001).
-- Aplicada en producción el 2026-09-29.
-- ============================================================
UPDATE public.paquetes_creditos_estudios
   SET descripcion = '5 estudios de arrendamiento — $70.000 + IVA c/u', updated_at = now()
 WHERE cantidad_estudios = 5 AND descripcion = '5 estudios de arrendamiento — $70.000 c/u';

UPDATE public.paquetes_creditos_estudios
   SET descripcion = '10 estudios de arrendamiento — $64.000 + IVA c/u', updated_at = now()
 WHERE cantidad_estudios = 10 AND descripcion = '10 estudios de arrendamiento — $64.000 c/u';

UPDATE public.paquetes_creditos_estudios
   SET descripcion = '25 estudios de arrendamiento — $56.000 + IVA c/u', updated_at = now()
 WHERE cantidad_estudios = 25 AND descripcion = '25 estudios de arrendamiento — $56.000 c/u';
