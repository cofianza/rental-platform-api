-- ============================================================
-- Ampliar listas de inmueble (tareas 2.1 / 2.4)
-- ------------------------------------------------------------
-- Nuevos tipos de inmueble para vitrina y creación de propiedad, uso "mixto",
-- y estrato hasta 7. CORRER ANTES de desplegar la API que acepta estos valores
-- en sus schemas Zod (inmuebles.schema.ts).
--
-- Nota: ALTER TYPE ... ADD VALUE es idempotente con IF NOT EXISTS y no usamos
-- los valores nuevos en esta misma migración (solo los agregamos), así que es
-- seguro correr todos los statements juntos en el SQL editor de Supabase.
-- ============================================================

-- Tipos de inmueble (local y bodega ya existían).
ALTER TYPE public.tipo_inmueble ADD VALUE IF NOT EXISTS 'apartaestudio';
ALTER TYPE public.tipo_inmueble ADD VALUE IF NOT EXISTS 'casa_finca';
ALTER TYPE public.tipo_inmueble ADD VALUE IF NOT EXISTS 'finca';
ALTER TYPE public.tipo_inmueble ADD VALUE IF NOT EXISTS 'lote';
ALTER TYPE public.tipo_inmueble ADD VALUE IF NOT EXISTS 'parqueadero';

-- Uso "mixto" (vivienda + comercial en un mismo inmueble). 'comercial' y
-- 'local_comercial' ya existían; la UI ofrecerá Vivienda / Comercio / Mixto.
ALTER TYPE public.uso_inmueble ADD VALUE IF NOT EXISTS 'mixto';

-- Estrato hasta 7 (antes el CHECK topaba en 6).
ALTER TABLE public.inmuebles DROP CONSTRAINT IF EXISTS inmuebles_estrato_check;
ALTER TABLE public.inmuebles
  ADD CONSTRAINT inmuebles_estrato_check CHECK (estrato >= 1 AND estrato <= 7);
