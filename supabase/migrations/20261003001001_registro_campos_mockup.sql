-- ============================================================
-- Registro v2 (mockup de Gerencia, 2026-10-02): tres datos comerciales nuevos.
-- Opcionales y sin default: handle_new_user inserta solo id/nombre/apellido/rol,
-- así que el trigger NO se toca y no puede romperse por esto.
-- Idempotente. La API escribe estas columnas en un UPDATE aparte (best-effort):
-- funciona igual antes y después de correr esta migración.
-- ============================================================

ALTER TABLE public.perfiles
  ADD COLUMN IF NOT EXISTS origen_registro       VARCHAR(30),
  ADD COLUMN IF NOT EXISTS inmuebles_gestionados VARCHAR(10),
  ADD COLUMN IF NOT EXISTS sitio_web             VARCHAR(300);

COMMENT ON COLUMN public.perfiles.origen_registro IS
  '¿Cómo nos conoció? (registro): inmobiliaria | redes | recomendacion | google | evento | otro. Validado en la capa de app.';
COMMENT ON COLUMN public.perfiles.inmuebles_gestionados IS
  'Rango de inmuebles que gestiona la inmobiliaria al registrarse (dato comercial, no operativo).';
COMMENT ON COLUMN public.perfiles.sitio_web IS
  'Página web de la inmobiliaria (opcional).';

ALTER TABLE public.perfiles DROP CONSTRAINT IF EXISTS chk_perfiles_inmuebles_gestionados;
ALTER TABLE public.perfiles ADD CONSTRAINT chk_perfiles_inmuebles_gestionados CHECK (
  inmuebles_gestionados IS NULL
  OR inmuebles_gestionados IN ('1-20','21-50','51-100','101-300','300+'));

-- origen_registro sin CHECK a propósito: la lista de opciones es de marketing y va a cambiar
-- (mismo criterio que afianzadora_tipo, 20260706000002).

-- Comprobación (debe devolver 3):
SELECT count(*) AS columnas_nuevas
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'perfiles'
   AND column_name IN ('origen_registro', 'inmuebles_gestionados', 'sitio_web');

-- ROLLBACK (solo si hay que deshacer; se pierden los datos de las tres columnas):
-- ALTER TABLE public.perfiles DROP CONSTRAINT IF EXISTS chk_perfiles_inmuebles_gestionados;
-- ALTER TABLE public.perfiles
--   DROP COLUMN IF EXISTS origen_registro,
--   DROP COLUMN IF EXISTS inmuebles_gestionados,
--   DROP COLUMN IF EXISTS sitio_web;
