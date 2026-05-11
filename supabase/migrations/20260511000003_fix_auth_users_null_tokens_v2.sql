-- ============================================================
-- Fix v2: "Database error loading user" — segunda pasada.
--
-- La primera migracion (20260511000002) cubrio 6 columnas de tokens pero
-- el error persistio. GoTrue tambien lee otras dos columnas string que
-- pueden estar en NULL y romper el escaneo:
--   - email_change      (string del nuevo email pendiente)
--   - phone_change      (string del nuevo telefono pendiente)
--
-- Tambien aseguramos columnas auxiliares que GoTrue espera como NOT NULL
-- pero que pueden haber quedado en NULL en filas legacy:
--   - email_change_confirm_status (smallint, default 0)
--   - is_sso_user (boolean, default false)
--   - is_anonymous (boolean, default false — agregado en GoTrue v2.143+)
--
-- Esta migracion es idempotente — solo toca filas con NULL.
-- ============================================================

-- 1. Strings: NULL → ''
UPDATE auth.users
SET
  confirmation_token         = COALESCE(confirmation_token, ''),
  recovery_token             = COALESCE(recovery_token, ''),
  email_change_token_new     = COALESCE(email_change_token_new, ''),
  email_change_token_current = COALESCE(email_change_token_current, ''),
  email_change               = COALESCE(email_change, ''),
  phone_change_token         = COALESCE(phone_change_token, ''),
  phone_change               = COALESCE(phone_change, ''),
  reauthentication_token     = COALESCE(reauthentication_token, '')
WHERE
  confirmation_token         IS NULL OR
  recovery_token             IS NULL OR
  email_change_token_new     IS NULL OR
  email_change_token_current IS NULL OR
  email_change               IS NULL OR
  phone_change_token         IS NULL OR
  phone_change               IS NULL OR
  reauthentication_token     IS NULL;

-- 2. Numeric / boolean: NULL → default seguro
DO $$
BEGIN
  -- email_change_confirm_status existe siempre; lo normalizamos a 0.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = 'email_change_confirm_status'
  ) THEN
    EXECUTE 'UPDATE auth.users SET email_change_confirm_status = 0 WHERE email_change_confirm_status IS NULL';
  END IF;

  -- is_sso_user (default false). Existe desde GoTrue ~v2.50.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = 'is_sso_user'
  ) THEN
    EXECUTE 'UPDATE auth.users SET is_sso_user = false WHERE is_sso_user IS NULL';
  END IF;

  -- is_anonymous (default false). Existe desde GoTrue v2.143+.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = 'is_anonymous'
  ) THEN
    EXECUTE 'UPDATE auth.users SET is_anonymous = false WHERE is_anonymous IS NULL';
  END IF;
END $$;
