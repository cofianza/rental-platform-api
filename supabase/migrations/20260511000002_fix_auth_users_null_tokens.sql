-- ============================================================
-- Fix: "Database error loading user" al llamar auth.admin.updateUserById
--
-- Sintoma: al intentar resetear la contrasena de un usuario desde el panel
-- de admin, Supabase Auth devuelve 500 con el mensaje
-- "Database error loading user".
--
-- Causa raiz: bug conocido de GoTrue (Supabase Auth). Las columnas de
-- tokens en `auth.users` (confirmation_token, recovery_token,
-- email_change_token_new/current, phone_change_token,
-- reauthentication_token) deben estar en cadena vacia '' por defecto.
-- Si quedan en NULL — sea por migracion incompleta, restauracion de
-- backup, o INSERT directo legacy — el codigo de GoTrue intenta hacer
-- scan a `string` y revienta antes de poder cargar el usuario.
--
-- Solucion: normalizar cualquier NULL a '' en todas las filas. Es seguro
-- ejecutar varias veces (idempotente — solo toca filas con NULL).
-- ============================================================

UPDATE auth.users
SET
  confirmation_token          = COALESCE(confirmation_token, ''),
  recovery_token              = COALESCE(recovery_token, ''),
  email_change_token_new      = COALESCE(email_change_token_new, ''),
  email_change_token_current  = COALESCE(email_change_token_current, ''),
  phone_change_token          = COALESCE(phone_change_token, ''),
  reauthentication_token      = COALESCE(reauthentication_token, '')
WHERE
  confirmation_token          IS NULL OR
  recovery_token              IS NULL OR
  email_change_token_new      IS NULL OR
  email_change_token_current  IS NULL OR
  phone_change_token          IS NULL OR
  reauthentication_token      IS NULL;
