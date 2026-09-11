-- ============================================================
-- perfiles.municipio_codigo / municipio_nombre — municipio DANE para facturar
-- ------------------------------------------------------------
-- Adenda 2 §7, opcion B: la inmobiliaria (o el propietario) paga el estudio
-- por la pasarela, asi que la factura electronica sale a SU nombre, no al del
-- solicitante. Factus/DIAN exigen el codigo DANE del municipio del cliente
-- (5 digitos) y el perfil no lo guardaba: solo `domicilio_ciudad` en texto.
-- Sin el, la factura automatica no puede salir y queda para emitirla a mano.
--
-- Se captura una vez en "Datos para contrato" (perfil canonico de la org).
-- Nullable: un perfil sin municipio sigue funcionando; su factura queda
-- pendiente con el faltante 'municipio_codigo', como hoy.
-- ============================================================

ALTER TABLE public.perfiles
  ADD COLUMN IF NOT EXISTS municipio_codigo VARCHAR(5),
  ADD COLUMN IF NOT EXISTS municipio_nombre VARCHAR(120);

ALTER TABLE public.perfiles
  DROP CONSTRAINT IF EXISTS chk_perfiles_municipio_codigo;

ALTER TABLE public.perfiles
  ADD CONSTRAINT chk_perfiles_municipio_codigo CHECK (municipio_codigo IS NULL OR municipio_codigo ~ '^[0-9]{5}$');

COMMENT ON COLUMN public.perfiles.municipio_codigo IS
  'Codigo DANE (5 digitos) del municipio del arrendador, para la factura electronica cuando paga el estudio (Adenda 2 §7, opcion B).';

-- ------------------------------------------------------------
-- ROLLBACK (manual, no se ejecuta aqui)
--
--   ALTER TABLE public.perfiles DROP CONSTRAINT IF EXISTS chk_perfiles_municipio_codigo;
--   ALTER TABLE public.perfiles DROP COLUMN IF EXISTS municipio_codigo, DROP COLUMN IF EXISTS municipio_nombre;
