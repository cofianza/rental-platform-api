-- ============================================================
-- Plantilla única de contrato + datos del arrendador
--
-- Contexto: Cofianza emite contratos de arrendamiento. El ARRENDADOR es:
--   - La inmobiliaria, cuando el inmueble es gestionado por una
--     (perfiles.rol = 'inmobiliaria').
--   - El propietario, cuando es gestión directa (perfiles.rol = 'propietario').
-- En el caso de inmobiliaria, el contrato lleva su logo en la cabecera.
--
-- Esta migración:
--  1. Permite guardar el HTML de la plantilla directo en DB (en lugar de
--     un archivo en storage), para que el admin pueda editar el contrato
--     sin re-subir archivos.
--  2. Agrega los campos de arrendador al perfil (comunes a inmobiliaria
--     y propietario; los exclusivos de inmobiliaria como matricula y
--     logo quedan en NULL para propietarios).
--  3. Inserta dos parámetros configurables: valor del afianzamiento
--     mensual (default $20.000) y porcentaje de comisión de
--     intermediación (default 20%, solo aplica con inmobiliaria).
-- ============================================================

-- ── 1. Plantillas de contrato: cuerpo HTML editable ────────────────
ALTER TABLE plantillas_contrato
  ADD COLUMN IF NOT EXISTS contenido_html TEXT;

COMMENT ON COLUMN plantillas_contrato.contenido_html IS 'HTML del contrato con placeholders {{variable}} y bloques {{#if cond}}…{{/if}}. Renderizado a PDF al generar el contrato.';

-- ── 2. Perfiles: datos del arrendador (inmobiliaria + propietario) ─
-- Comunes a ambos roles.
ALTER TABLE perfiles
  ADD COLUMN IF NOT EXISTS representante_legal       TEXT,
  ADD COLUMN IF NOT EXISTS domicilio_direccion       TEXT,
  ADD COLUMN IF NOT EXISTS domicilio_ciudad          TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_recaudo          TEXT,
  ADD COLUMN IF NOT EXISTS email_recaudo             TEXT,
  ADD COLUMN IF NOT EXISTS cuenta_recaudo_banco      TEXT,
  ADD COLUMN IF NOT EXISTS cuenta_recaudo_tipo       TEXT,  -- 'ahorros' | 'corriente'
  ADD COLUMN IF NOT EXISTS cuenta_recaudo_numero     TEXT,
  ADD COLUMN IF NOT EXISTS cuenta_recaudo_titular_nombre TEXT,
  ADD COLUMN IF NOT EXISTS cuenta_recaudo_titular_nit    TEXT;

-- Específicos de inmobiliaria.
ALTER TABLE perfiles
  ADD COLUMN IF NOT EXISTS matricula_arrendador      TEXT,
  ADD COLUMN IF NOT EXISTS logo_storage_key          TEXT,
  ADD COLUMN IF NOT EXISTS logo_url                  TEXT;

COMMENT ON COLUMN perfiles.representante_legal IS 'Nombre del representante legal (solo persona juridica, ej. inmobiliaria).';
COMMENT ON COLUMN perfiles.domicilio_direccion IS 'Direccion del domicilio del arrendador para la cabecera del contrato.';
COMMENT ON COLUMN perfiles.domicilio_ciudad IS 'Ciudad del domicilio del arrendador.';
COMMENT ON COLUMN perfiles.whatsapp_recaudo IS 'Numero WhatsApp para notificaciones de pago (paragrafo 1 clausula CUARTA).';
COMMENT ON COLUMN perfiles.email_recaudo IS 'Email para notificaciones de pago (paragrafo 1 clausula CUARTA).';
COMMENT ON COLUMN perfiles.cuenta_recaudo_banco IS 'Banco de la cuenta donde se recauda el canon.';
COMMENT ON COLUMN perfiles.cuenta_recaudo_tipo IS 'ahorros | corriente';
COMMENT ON COLUMN perfiles.cuenta_recaudo_numero IS 'Numero de cuenta donde se recauda el canon.';
COMMENT ON COLUMN perfiles.cuenta_recaudo_titular_nombre IS 'Nombre/razon social del titular de la cuenta.';
COMMENT ON COLUMN perfiles.cuenta_recaudo_titular_nit IS 'NIT/CC del titular de la cuenta.';
COMMENT ON COLUMN perfiles.matricula_arrendador IS 'Matricula de arrendador expedida por alcaldia (solo inmobiliaria).';
COMMENT ON COLUMN perfiles.logo_storage_key IS 'Key del logo en Supabase Storage (solo inmobiliaria, propietario directo no usa logo).';
COMMENT ON COLUMN perfiles.logo_url IS 'URL publica/firmada del logo (cache del storage_key).';

-- ── 3. Configuracion: afianzamiento + comision ─────────────────────
INSERT INTO configuracion_sistema (clave, valor, descripcion)
VALUES
  ('valor_afianzamiento_mensual',
   '20000',
   'Valor mensual del servicio de afianzamiento (COP), inyectado en paragrafo 3 clausula CUARTA del contrato.'),
  ('comision_intermediacion_porcentaje',
   '20',
   'Porcentaje de comision de intermediacion sobre el canon (clausula VIGESIMA TERCERA). Solo aplica cuando el ARRENDADOR es inmobiliaria; en propietario directo la clausula no se renderiza.')
ON CONFLICT (clave) DO NOTHING;

-- ── 4. Deprecar contrato tipo subido por propietario ───────────────
-- Ya no se usa: la plantilla unica reemplaza esta funcionalidad. Mantenemos
-- la columna por compatibilidad (inmuebles existentes con datos), pero la
-- UI deja de exponerla.
COMMENT ON COLUMN inmuebles.contrato_tipo_storage_key IS 'DEPRECADO 2026-04-27: la plantilla unica de contrato reemplaza esta funcionalidad. No leer ni mostrar en UI.';
