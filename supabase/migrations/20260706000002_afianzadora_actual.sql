-- ============================================================
-- Afianzadora / aseguradora actual de la inmobiliaria (tarea 1.6)
-- ------------------------------------------------------------
-- Se pregunta en el registro de inmobiliaria "¿Qué afianzadora o aseguradora
-- usan hoy?" para dimensionar el ahorro / la conversión. Campos opcionales.
-- ============================================================

ALTER TABLE public.perfiles
  ADD COLUMN IF NOT EXISTS afianzadora_actual VARCHAR(200),
  -- 'afianzadora' | 'aseguradora' | 'ninguna' (validado en la capa de app).
  ADD COLUMN IF NOT EXISTS afianzadora_tipo VARCHAR(20);
