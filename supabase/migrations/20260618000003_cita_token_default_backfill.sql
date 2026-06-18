-- ============================================================
-- Migración: Token de cita automático (DEFAULT) + backfill
-- Fecha: 2026-06-18
-- Descripción:
--   La generación perezosa del token en el código (ensureCitaToken) no
--   resultaba confiable y dejaba citas con token NULL → el WhatsApp de
--   confirmación (plantilla v2 con botones de URL dinámica) fallaba con
--   "(#131008) Required parameter is missing" porque sin token no se
--   mandan los parámetros de los botones.
--
--   Solución robusta: que Postgres genere el token en CADA inserción
--   (cualquier ruta: createCita, vitrina, etc.) y rellenar las citas
--   existentes con token NULL. Token = 64 hex (dos UUID concatenados,
--   sin guiones) — mismo formato que randomBytes(32).hex y único.
-- ============================================================

-- 1. Default: toda cita nueva nace con token.
ALTER TABLE citas
  ALTER COLUMN token SET DEFAULT (
    replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
  );

-- 2. Backfill: citas existentes sin token.
UPDATE citas
   SET token = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
 WHERE token IS NULL;
