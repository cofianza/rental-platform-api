-- ============================================================
-- A13 (revision 2026-09-25): PPT y PEP como tipo de documento.
-- ------------------------------------------------------------
-- Flujo del modulo de estudios §5.1: «Cedula de ciudadania, cedula de
-- extranjeria, PPT o PEP. El PPT y el PEP son necesarios para atender
-- poblacion migrante.»
--
--   ppt = Permiso por Proteccion Temporal
--   pep = Permiso Especial de Permanencia
--
-- DataCredito (HDC+PN, Tabla 1): PPT=6, PEP=9. TransUnion no tiene codigo
-- documentado para ninguno de los dos (su provider responde 400 claro
-- antes de llamar al buro). La Politica §15 ya los manda a revision manual.
--
-- Afecta a todas las columnas tipo public.tipo_documento_id (solicitantes,
-- expediente_coarrendatarios, contrato_partes, autorizaciones, perfiles…).
-- Las columnas VARCHAR de firmantes no tienen CHECK y ya admiten cualquier
-- valor; perfiles.representante_legal_tipo_documento (CHECK cc/ce/pasaporte)
-- se deja igual: es el representante de una empresa, no el inquilino.
--
-- CORRER ANTES de desplegar la API que acepta 'ppt'/'pep' en sus schemas Zod.
-- ADD VALUE va en su propia migracion (no se puede usar el valor en la misma
-- transaccion que lo crea). Idempotente.
-- ============================================================

ALTER TYPE public.tipo_documento_id ADD VALUE IF NOT EXISTS 'ppt';
ALTER TYPE public.tipo_documento_id ADD VALUE IF NOT EXISTS 'pep';
