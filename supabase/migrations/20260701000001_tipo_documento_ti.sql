-- ============================================================
-- Agregar 'ti' (Tarjeta de Identidad) al enum tipo_documento_id
-- ------------------------------------------------------------
-- Los formularios web (invitar co-arrendatario, reintentar estudio,
-- formulario del solicitante) ofrecen TI y TransUnion la soporta
-- (TIPO_DOCUMENTO_MAP: ti → '4'), pero el enum de Postgres no la tenía:
-- cualquier INSERT/UPDATE con 'ti' reventaba con 22P02.
--
-- CORRER ANTES de desplegar la API que acepta 'ti' en sus schemas Zod
-- (coarrendatarios.schema.ts y estudios.schema.ts).
--
-- Nota: ALTER TYPE ... ADD VALUE va en su propia migración (el valor nuevo
-- no puede usarse en la misma transacción que lo crea).
-- ============================================================

ALTER TYPE public.tipo_documento_id ADD VALUE IF NOT EXISTS 'ti';
