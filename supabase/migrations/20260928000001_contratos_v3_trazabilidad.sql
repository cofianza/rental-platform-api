-- Contratos V3 — huecos de la revisión de trazabilidad contra la especificación
-- de Gerencia (2026-09-22). Solo columnas nuevas y opcionales: no toca datos.
--
-- CORRER ANTES del push de la API que las lee (el asistente las selecciona al
-- cargar un contrato; sin ellas el asistente responde 500).

-- §7.2: modalidad de la fianza que fija el convenio de la inmobiliaria. La
-- administra Cofianza (/admin/inmobiliarias); el asistente la presenta
-- preseleccionada y la inmobiliaria puede cambiarla contrato por contrato.
-- NULL = el convenio no fija modalidad.
ALTER TABLE public.inmobiliarias
  ADD COLUMN IF NOT EXISTS modalidad_fianza_defecto text;

ALTER TABLE public.inmobiliarias
  DROP CONSTRAINT IF EXISTS inmobiliarias_modalidad_fianza_defecto_chk;
ALTER TABLE public.inmobiliarias
  ADD CONSTRAINT inmobiliarias_modalidad_fianza_defecto_chk
  CHECK (modalidad_fianza_defecto IS NULL OR modalidad_fianza_defecto IN ('trasladada', 'tradicional'));

-- §1.4: lo que el asistente confirma del inmueble vuelve a su registro, no solo
-- al contrato (hasta ahora solo propiedad_horizontal).
ALTER TABLE public.inmuebles
  ADD COLUMN IF NOT EXISTS nombre_copropiedad varchar(150),
  ADD COLUMN IF NOT EXISTS parqueadero_numero varchar(40),
  ADD COLUMN IF NOT EXISTS parqueadero_moto boolean,
  ADD COLUMN IF NOT EXISTS parqueadero_moto_numero varchar(40),
  ADD COLUMN IF NOT EXISTS cuarto_util_numero varchar(40);

-- §8.7.2: dirección y municipio de notificación del coarrendatario. Los da él
-- mismo al aceptar la invitación; el paso 5 del asistente los precarga.
ALTER TABLE public.expediente_coarrendatarios
  ADD COLUMN IF NOT EXISTS direccion varchar(300),
  ADD COLUMN IF NOT EXISTS municipio varchar(120);
