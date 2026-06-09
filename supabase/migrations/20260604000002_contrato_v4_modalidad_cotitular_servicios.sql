-- ============================================================
-- Fase 3 del contrato V4: datos que alimentan las variables restantes.
--   - modalidades_fianza (lookup): modalidad → comisión, prima, cobertura (cob.*)
--   - expedientes: modalidad seleccionada + co-titular (cotitular.*) + reparto de
--     servicios públicos (serv.*)
--   - perfiles: matrícula de arrendador (expedida por / fecha) → inmobiliaria.*
--   - inmuebles: matrícula inmobiliaria → inmueble.matricula_inmobiliaria
--
-- ⚠️ Los valores de comisión/prima por modalidad quedan VACÍOS a propósito:
-- son cifras de negocio que debe fijar Cofianza. Edítalos con UPDATE (abajo hay
-- un ejemplo comentado) antes de usar el V4 en producción.
-- ============================================================

-- 1. Lookup de modalidades de fianza.
CREATE TABLE IF NOT EXISTS modalidades_fianza (
  codigo          TEXT PRIMARY KEY,
  nombre          TEXT NOT NULL,
  comision_texto  TEXT NOT NULL DEFAULT '',   -- ej. 'el 5%' del canon (FIJAR)
  prima_texto     TEXT NOT NULL DEFAULT '',   -- ej. 'el 50%' del canon (FIJAR)
  cubre_canones   BOOLEAN NOT NULL DEFAULT true,
  cubre_servicios BOOLEAN NOT NULL DEFAULT false,
  cubre_admin_ph  BOOLEAN NOT NULL DEFAULT false,
  cubre_danos     BOOLEAN NOT NULL DEFAULT false,
  cubre_penal     BOOLEAN NOT NULL DEFAULT true,
  activa          BOOLEAN NOT NULL DEFAULT true,
  orden           SMALLINT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed de las 3 modalidades (coberturas con defaults razonables; comisión/prima
-- vacías para que las fije Cofianza).
INSERT INTO modalidades_fianza
  (codigo, nombre, comision_texto, prima_texto, cubre_canones, cubre_servicios, cubre_admin_ph, cubre_danos, cubre_penal, orden)
VALUES
  ('plena',      'Cofianza Plena',      '', '', true, true,  true,  false, true, 1),
  ('compartida', 'Cofianza Compartida', '', '', true, true,  true,  false, true, 2),
  ('plus',       'Cofianza Plus',       '', '', true, true,  true,  true,  true, 3)
ON CONFLICT (codigo) DO NOTHING;

-- Ejemplo para fijar los valores reales (descomentar y ajustar):
-- UPDATE modalidades_fianza SET comision_texto = 'el 5%',  prima_texto = 'el 50%' WHERE codigo = 'plena';
-- UPDATE modalidades_fianza SET comision_texto = 'el 4%',  prima_texto = 'el 60%' WHERE codigo = 'compartida';
-- UPDATE modalidades_fianza SET comision_texto = 'el 6%',  prima_texto = 'el 50%' WHERE codigo = 'plus';

-- 2. Modalidad seleccionada + co-titular + reparto de servicios en el expediente.
ALTER TABLE expedientes
  ADD COLUMN IF NOT EXISTS modalidad_fianza TEXT NOT NULL DEFAULT 'plena'
    REFERENCES modalidades_fianza(codigo),
  ADD COLUMN IF NOT EXISTS cotitular_nombre         TEXT,
  ADD COLUMN IF NOT EXISTS cotitular_tipo_documento TEXT,
  ADD COLUMN IF NOT EXISTS cotitular_documento      TEXT,
  ADD COLUMN IF NOT EXISTS cotitular_celular        TEXT,
  ADD COLUMN IF NOT EXISTS cotitular_correo         TEXT,
  ADD COLUMN IF NOT EXISTS cotitular_direccion      TEXT,
  ADD COLUMN IF NOT EXISTS cotitular_municipio      TEXT,
  -- Reparto de servicios públicos: clave servicio → 'arrendatario' | 'arrendador'.
  -- Ej: {"agua":"arrendatario","energia":"arrendatario","gas":"arrendatario",
  --      "basuras":"arrendatario","alumbrado":"arrendatario","internet":"arrendatario",
  --      "admin_ph":"arrendatario"}
  ADD COLUMN IF NOT EXISTS servicios_reparto JSONB;

COMMENT ON COLUMN expedientes.modalidad_fianza IS 'Modalidad de fianza aprobada (FK modalidades_fianza). Maneja comisión, prima y cobertura del contrato.';
COMMENT ON COLUMN expedientes.servicios_reparto IS 'Reparto de servicios públicos del contrato: {servicio: arrendatario|arrendador}.';

-- 3. Datos de matrícula de arrendador (inmobiliaria) en el perfil.
ALTER TABLE perfiles
  ADD COLUMN IF NOT EXISTS matricula_expedida_por TEXT,
  ADD COLUMN IF NOT EXISTS matricula_fecha        TEXT;

-- 4. Matrícula inmobiliaria del inmueble.
ALTER TABLE inmuebles
  ADD COLUMN IF NOT EXISTS matricula_inmobiliaria TEXT;
