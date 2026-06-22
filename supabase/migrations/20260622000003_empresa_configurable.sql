-- ============================================================
-- Datos de la empresa (Cofianza) editables por el administrador
-- ------------------------------------------------------------
-- Antes los datos de la empresa (nombre, NIT, dirección, teléfono, email,
-- web, validez de certificados) vivían hardcoded en src/config/company.ts.
-- Ahora se guardan en configuracion_sistema bajo la clave 'empresa' (JSON) y
-- el administrador los edita desde el panel. company.ts queda como defaults/
-- fallback (getCompany() mezcla el JSON sobre los defaults).
--
-- Seed con los valores actuales. ON CONFLICT no pisa si ya existe.
-- ============================================================

INSERT INTO public.configuracion_sistema (clave, valor, tipo, descripcion)
VALUES (
  'empresa',
  '{"name":"Cofianza S.A.S.","nit":"901.XXX.XXX-X","address":"Bogota, Colombia","phone":"+52 6141211526","email":"info@cofianza.com","website":"www.cofianza.com","certificateValidityDays":30}',
  'json',
  'Datos de la empresa (Cofianza): nombre, NIT, dirección, teléfono, email, web, validez de certificados. Editable por el administrador.'
)
ON CONFLICT (clave) DO NOTHING;
