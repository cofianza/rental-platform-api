-- ============================================================
-- Codigo de propiedad libre y obligatorio (Mario, 12-may-2026).
--
-- Cambio de filosofia: el codigo dejaba de ser autogenerado por el
-- sistema y pasa a ser input del usuario (ej. APT-001, CASA-SAB). Esto
-- es para que cada inmobiliaria/propietario use su propio sistema de
-- codigos y pueda cruzar reportes con su sistema interno.
--
--   - Quitamos el trigger autogenerador.
--   - Hacemos codigo NOT NULL (no hay rows con NULL en este momento).
--   - Cambiamos UNIQUE global por UNIQUE (propietario_id, codigo) — la
--     misma propiedad codificada como "APT-001" puede existir en dos
--     inmobiliarias distintas. Dentro de una misma inmobiliaria, no.
-- ============================================================

DROP TRIGGER IF EXISTS inmuebles_generar_codigo ON public.inmuebles;

-- VARCHAR(10) era estrecho para codigos compuestos como "INMVALL-001-A".
ALTER TABLE public.inmuebles
  ALTER COLUMN codigo TYPE VARCHAR(30);

ALTER TABLE public.inmuebles
  ALTER COLUMN codigo SET NOT NULL;

ALTER TABLE public.inmuebles
  DROP CONSTRAINT IF EXISTS inmuebles_codigo_key;

ALTER TABLE public.inmuebles
  ADD CONSTRAINT inmuebles_codigo_por_propietario_unique
  UNIQUE (propietario_id, codigo);

COMMENT ON COLUMN public.inmuebles.codigo IS
  'Codigo del inmueble definido por la inmobiliaria/propietario (ej. APT-001, CASA-SAB). Obligatorio. Unico por propietario.';

DROP FUNCTION IF EXISTS public.generar_codigo_inmueble();
DROP SEQUENCE IF EXISTS public.inmueble_codigo_seq;
