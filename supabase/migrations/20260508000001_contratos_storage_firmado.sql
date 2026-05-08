-- ============================================================
-- Almacenar el PDF firmado por Auco junto al original.
--
-- Cuando Auco completa la firma electronica del contrato, nos manda un
-- webhook FINISH con una signed URL al PDF firmado (con certificado de
-- firma, hash, OTP, etc). Lo descargamos y lo subimos a nuestro Supabase
-- Storage para no depender de la URL temporal de Auco.
--
-- - storage_key_firmado: ruta dentro del bucket donde guardamos el PDF firmado.
-- - nombre_archivo_firmado: nombre legible para el download.
--
-- Idempotente con IF NOT EXISTS para que se pueda re-ejecutar.
-- ============================================================

ALTER TABLE contratos
  ADD COLUMN IF NOT EXISTS storage_key_firmado TEXT,
  ADD COLUMN IF NOT EXISTS nombre_archivo_firmado VARCHAR(255);

COMMENT ON COLUMN contratos.storage_key_firmado IS
  'Ruta dentro del bucket documentos-expedientes con el PDF firmado por Auco. Null si todavia no se ha firmado.';

COMMENT ON COLUMN contratos.nombre_archivo_firmado IS
  'Nombre legible del PDF firmado (ej. "contrato-EXP-2026-0026-firmado-v1.pdf").';
