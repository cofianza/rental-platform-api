-- ============================================================
-- Migración: Versionar rol 'solicitante' en enum rol_usuario
-- Fecha: 2026-04-17
-- Descripción:
--   Versiona el valor 'solicitante' que ya existe en el enum
--   rol_usuario en la DB remota pero que no estaba versionado.
--   Esto asegura que un `supabase db reset` o un redeploy desde
--   cero no rompa el flujo de vitrina pública (vitrina.service.ts
--   y permissions.ts dependen de este rol).
--
-- Nota: ALTER TYPE ... ADD VALUE debe estar solo en su archivo,
--   separado de migraciones que USEN el valor, porque Postgres
--   no permite usar un valor enum recién agregado en la misma
--   transacción donde fue agregado.
-- ============================================================

ALTER TYPE rol_usuario ADD VALUE IF NOT EXISTS 'solicitante';
