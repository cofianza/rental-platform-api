-- ============================================================
-- Interesados de la vitrina (leads pre-expediente)
-- ------------------------------------------------------------
-- Cuando un visitante SIN cuenta da "Me interesa este inmueble", en vez de
-- forzarlo a registrarse capturamos un lead mínimo (nombre, WhatsApp, correo) +
-- su autorización de tratamiento de datos, y avisamos al dueño/inmobiliaria que
-- publicó (in-app + WhatsApp + correo) para que lo contacte. NO se piden datos
-- sensibles (cédula/ingresos) — eso solo se pide después si avanza al estudio.
--
-- `propietario_id` / `inmobiliaria_id` se denormalizan desde el inmueble para
-- scopear quién puede ver el lead (cada dueño/agencia ve solo los suyos), igual
-- que inmuebles/expedientes. Aislamiento en capa de app (service_role bypassa RLS).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.inmueble_interesados (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inmueble_id      UUID NOT NULL REFERENCES public.inmuebles(id) ON DELETE CASCADE,
  -- Denormalizado para scoping de lectura (dueño individual o inmobiliaria).
  propietario_id   UUID,
  inmobiliaria_id  UUID,
  -- Datos de contacto del interesado (no sensibles).
  nombre           VARCHAR(150) NOT NULL,
  telefono         VARCHAR(30)  NOT NULL,
  email            VARCHAR(255) NOT NULL,
  -- Autorización de tratamiento de datos (Ley 1581) — obligatoria en el form.
  acepta_datos     BOOLEAN NOT NULL DEFAULT false,
  acepta_datos_at  TIMESTAMPTZ,
  -- Trazabilidad de la captura.
  ip               VARCHAR(45),
  user_agent       TEXT,
  -- Gestión del lead por parte del dueño.
  estado           VARCHAR(20) NOT NULL DEFAULT 'nuevo'
                     CHECK (estado IN ('nuevo', 'contactado', 'descartado')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inmueble_interesados_inmueble
  ON public.inmueble_interesados (inmueble_id);
CREATE INDEX IF NOT EXISTS idx_inmueble_interesados_propietario
  ON public.inmueble_interesados (propietario_id);
CREATE INDEX IF NOT EXISTS idx_inmueble_interesados_inmobiliaria
  ON public.inmueble_interesados (inmobiliaria_id);
CREATE INDEX IF NOT EXISTS idx_inmueble_interesados_created
  ON public.inmueble_interesados (created_at DESC);

COMMENT ON TABLE public.inmueble_interesados IS
  'Leads de la vitrina: interesados (sin cuenta) en un inmueble. Datos de contacto + autorización; el dueño los gestiona (nuevo/contactado/descartado).';
