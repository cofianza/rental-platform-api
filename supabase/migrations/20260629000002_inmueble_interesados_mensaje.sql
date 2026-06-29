-- ============================================================
-- Mensaje opcional del interesado en el formulario de la vitrina
-- ------------------------------------------------------------
-- El visitante puede dejar un mensaje corto al "Me interesa este inmueble"
-- (ej. "¿Sigue disponible? Me gustaría verlo el sábado"). Le da contexto al
-- dueño/inmobiliaria. Opcional, no sensible.
-- ============================================================

ALTER TABLE public.inmueble_interesados
  ADD COLUMN IF NOT EXISTS mensaje TEXT;
