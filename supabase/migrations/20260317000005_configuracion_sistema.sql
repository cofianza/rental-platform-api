-- ============================================================
-- Migration: Tabla configuracion_sistema
-- HP-353: Configurable pricing for estudios and other settings
-- ============================================================

CREATE TABLE IF NOT EXISTS configuracion_sistema (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clave VARCHAR(100) UNIQUE NOT NULL,
  valor TEXT NOT NULL,
  tipo VARCHAR(20) NOT NULL DEFAULT 'string', -- string, number, boolean, json
  descripcion TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_configuracion_clave ON configuracion_sistema(clave);

-- Seed: monto por defecto del estudio
INSERT INTO configuracion_sistema (clave, valor, tipo, descripcion)
VALUES ('monto_estudio', '80000', 'number', 'Monto del estudio de arrendamiento en COP')
ON CONFLICT (clave) DO NOTHING;
