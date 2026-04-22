-- ============================================================
-- Contrato tipo del inmueble
--
-- Permite al propietario/inmobiliaria subir un PDF de contrato que
-- servirá como base cuando se genere el contrato del expediente.
-- Alternativa a las plantillas con variables {{...}}: se usa tal cual.
-- ============================================================

ALTER TABLE inmuebles
  ADD COLUMN IF NOT EXISTS contrato_tipo_storage_key TEXT,
  ADD COLUMN IF NOT EXISTS contrato_tipo_nombre_archivo TEXT,
  ADD COLUMN IF NOT EXISTS contrato_tipo_tamano_bytes INT,
  ADD COLUMN IF NOT EXISTS contrato_tipo_subido_por UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS contrato_tipo_subido_en TIMESTAMPTZ;

COMMENT ON COLUMN inmuebles.contrato_tipo_storage_key IS 'Storage key del PDF de contrato tipo subido por el propietario. Si existe, se usa como base para el contrato del expediente en lugar de una plantilla.';
