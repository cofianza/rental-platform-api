-- ============================================================
-- HP-341: Solicitudes de firma electronica
-- ============================================================

-- Tipo enum para estado de solicitud
DO $$ BEGIN
  CREATE TYPE estado_solicitud_firma AS ENUM (
    'pendiente',
    'enviado',
    'abierto',
    'otp_validado',
    'firmado',
    'expirado',
    'cancelado'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS solicitudes_firma (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contrato_id           UUID NOT NULL REFERENCES contratos(id) ON DELETE CASCADE,
  nombre_firmante       VARCHAR(200) NOT NULL,  
  email_firmante        VARCHAR(255) NOT NULL,
  telefono_firmante     VARCHAR(20),
  token                 VARCHAR(64) NOT NULL UNIQUE,
  token_expiracion      TIMESTAMPTZ NOT NULL,
  estado                estado_solicitud_firma NOT NULL DEFAULT 'pendiente',
  envios_realizados     INT NOT NULL DEFAULT 0,
  max_envios            INT NOT NULL DEFAULT 5,
  enviado_por           UUID NOT NULL REFERENCES perfiles(id) ON DELETE SET NULL,
  abierto_en            TIMESTAMPTZ,
  firmado_en            TIMESTAMPTZ,
  ip_firmante           VARCHAR(45),
  user_agent_firmante   TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_solicitudes_firma_contrato ON solicitudes_firma(contrato_id);
CREATE INDEX IF NOT EXISTS idx_solicitudes_firma_token ON solicitudes_firma(token);
CREATE INDEX IF NOT EXISTS idx_solicitudes_firma_estado ON solicitudes_firma(estado);
