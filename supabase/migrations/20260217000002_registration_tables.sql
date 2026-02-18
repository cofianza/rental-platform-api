-- ============================================================
-- Migracion: Tablas y columnas para registro (HP-151)
-- Fecha: 2026-02-17
-- ============================================================

-- ============================================================
-- 1. NUEVAS COLUMNAS EN PERFILES
-- ============================================================

ALTER TABLE perfiles ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE perfiles ADD COLUMN IF NOT EXISTS registration_source VARCHAR(20);
ALTER TABLE perfiles ADD COLUMN IF NOT EXISTS razon_social VARCHAR(300);
ALTER TABLE perfiles ADD COLUMN IF NOT EXISTS nit VARCHAR(20);
ALTER TABLE perfiles ADD COLUMN IF NOT EXISTS direccion_comercial VARCHAR(300);
ALTER TABLE perfiles ADD COLUMN IF NOT EXISTS ciudad VARCHAR(100);
ALTER TABLE perfiles ADD COLUMN IF NOT EXISTS nombre_representante VARCHAR(200);
ALTER TABLE perfiles ADD COLUMN IF NOT EXISTS direccion VARCHAR(300);

-- ============================================================
-- 2. TABLA: email_verification_tokens
-- ============================================================

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES perfiles(id) ON DELETE CASCADE,
  token_hash  VARCHAR(64) NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_hash
  ON email_verification_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user
  ON email_verification_tokens(user_id);

ALTER TABLE email_verification_tokens ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 3. TABLA: terminos_aceptaciones
-- ============================================================

CREATE TABLE IF NOT EXISTS terminos_aceptaciones (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID NOT NULL REFERENCES perfiles(id) ON DELETE CASCADE,
  acepta_terminos          BOOLEAN NOT NULL,
  acepta_tratamiento_datos BOOLEAN NOT NULL,
  terminos_aceptados_at    TIMESTAMPTZ,
  datos_aceptados_at       TIMESTAMPTZ,
  ip_address               VARCHAR(45),
  user_agent               TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_terminos_aceptaciones_user
  ON terminos_aceptaciones(user_id);

ALTER TABLE terminos_aceptaciones ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 4. RPC: find_user_by_email
-- Busca un usuario por email cruzando auth.users con perfiles.
-- Usada por: resendVerification (HP-151), forgotPassword (HP-98)
-- ============================================================

DROP FUNCTION IF EXISTS find_user_by_email(TEXT);

CREATE OR REPLACE FUNCTION find_user_by_email(user_email TEXT)
RETURNS TABLE(id UUID, email TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT au.id, au.email::TEXT
  FROM auth.users au
  INNER JOIN public.perfiles p ON p.id = au.id
  WHERE au.email = user_email
  LIMIT 1;
$$;
