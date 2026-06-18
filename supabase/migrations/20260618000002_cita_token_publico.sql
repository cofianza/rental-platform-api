-- ============================================================
-- Migración: Token público de la cita (gestión sin login)
-- Fecha: 2026-06-18
-- Descripción:
--   Agrega un token opaco a citas para que el solicitante pueda
--   reprogramar/cancelar su visita desde los botones del WhatsApp
--   (página pública cofianza.co/visita/<accion>/<token>), sin login.
--   Sigue el patrón de tokens opacos del resto de flujos públicos
--   (hex de 32 bytes = 64 chars). No tiene expiración: el acceso se
--   limita por el estado de la cita (solo solicitada/confirmada son
--   accionables; el token se genera al confirmar la cita).
-- ============================================================

ALTER TABLE citas
  ADD COLUMN IF NOT EXISTS token VARCHAR(64) UNIQUE;

COMMENT ON COLUMN citas.token IS
  'Token opaco para gestión pública de la visita (reprogramar/cancelar desde WhatsApp). Se genera al confirmar la cita.';

CREATE INDEX IF NOT EXISTS idx_citas_token ON citas(token);
