-- ============================================================
-- Documentos Upload Service Migration
-- Crea tabla tipos_documento, altera documentos, seed datos
-- Fecha: 2026-02-26
-- ============================================================

-- ============================================================
-- 1. CREATE tipos_documento LOOKUP TABLE
-- ============================================================

CREATE TABLE tipos_documento (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo              VARCHAR(50) UNIQUE NOT NULL,
  nombre              VARCHAR(100) NOT NULL,
  descripcion         TEXT,
  es_obligatorio      BOOLEAN NOT NULL DEFAULT FALSE,
  formatos_aceptados  TEXT[] NOT NULL DEFAULT ARRAY[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp'
  ],
  tamano_maximo_mb    INTEGER NOT NULL DEFAULT 10,
  orden               INTEGER NOT NULL DEFAULT 0,
  activo              BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tipos_documento_codigo ON tipos_documento(codigo);
CREATE INDEX idx_tipos_documento_activo ON tipos_documento(activo) WHERE activo = TRUE;
CREATE INDEX idx_tipos_documento_orden  ON tipos_documento(orden);

CREATE TRIGGER tipos_documento_updated_at
  BEFORE UPDATE ON tipos_documento
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- 2. SEED tipos_documento DATA
-- ============================================================

INSERT INTO tipos_documento (codigo, nombre, descripcion, es_obligatorio, formatos_aceptados, tamano_maximo_mb, orden) VALUES
  ('id_frontal',              'ID frontal',                'Foto frontal del documento de identidad',                    TRUE,  ARRAY['image/jpeg','image/png','image/webp','application/pdf'], 10, 1),
  ('id_posterior',            'ID posterior',              'Foto posterior del documento de identidad',                   TRUE,  ARRAY['image/jpeg','image/png','image/webp','application/pdf'], 10, 2),
  ('comprobante_domicilio',   'Comprobante de domicilio',  'Recibo de servicios publicos o extracto bancario',           TRUE,  ARRAY['application/pdf','image/jpeg','image/png'],              10, 3),
  ('comprobante_ingresos',    'Comprobante de ingresos',   'Certificado laboral, desprendible de nomina u otro',         TRUE,  ARRAY['application/pdf','image/jpeg','image/png'],              10, 4),
  ('referencias_personales',  'Referencias personales',    'Carta de referencias personales',                            FALSE, ARRAY['application/pdf','image/jpeg','image/png'],              10, 5),
  ('referencias_laborales',   'Referencias laborales',     'Carta de referencias laborales',                             FALSE, ARRAY['application/pdf','image/jpeg','image/png'],              10, 6),
  ('selfie_con_id',           'Selfie con identificacion', 'Foto tipo selfie sosteniendo el documento de identidad',     TRUE,  ARRAY['image/jpeg','image/png','image/webp'],                   10, 7),
  ('otro',                    'Otro',                      'Otro tipo de documento no clasificado',                       FALSE, ARRAY['application/pdf','image/jpeg','image/png','image/webp'], 10, 8);

-- ============================================================
-- 3. ADD 'reemplazado' TO estado_documento ENUM
-- ============================================================

ALTER TYPE estado_documento ADD VALUE IF NOT EXISTS 'reemplazado';

-- ============================================================
-- 4. ALTER documentos TABLE - ADD NEW COLUMNS
-- ============================================================

-- FK to tipos_documento (nullable initially for data migration)
ALTER TABLE documentos ADD COLUMN tipo_documento_id UUID REFERENCES tipos_documento(id);

-- Generated file name (UUID-based)
ALTER TABLE documentos ADD COLUMN nombre_archivo VARCHAR(255);

-- Full path in Supabase Storage
ALTER TABLE documentos ADD COLUMN storage_key TEXT;

-- Who uploaded
ALTER TABLE documentos ADD COLUMN subido_por UUID REFERENCES perfiles(id);

-- Review date
ALTER TABLE documentos ADD COLUMN fecha_revision TIMESTAMPTZ;

-- Self-referencing FK for version chain
ALTER TABLE documentos ADD COLUMN reemplazado_por UUID REFERENCES documentos(id);

-- Updated at timestamp
ALTER TABLE documentos ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ============================================================
-- 5. MIGRATE DATA: enum tipo -> tipo_documento_id FK
-- ============================================================

UPDATE documentos d
SET tipo_documento_id = td.id
FROM tipos_documento td
WHERE (d.tipo::text = 'cedula_frontal'       AND td.codigo = 'id_frontal')
   OR (d.tipo::text = 'cedula_posterior'      AND td.codigo = 'id_posterior')
   OR (d.tipo::text = 'comprobante_domicilio' AND td.codigo = 'comprobante_domicilio')
   OR (d.tipo::text = 'comprobante_ingresos'  AND td.codigo = 'comprobante_ingresos')
   OR (d.tipo::text = 'referencias'           AND td.codigo = 'referencias_personales')
   OR (d.tipo::text = 'selfie_con_id'         AND td.codigo = 'selfie_con_id')
   OR (d.tipo::text = 'certificado_laboral'   AND td.codigo = 'comprobante_ingresos')
   OR (d.tipo::text = 'otro'                  AND td.codigo = 'otro');

-- Safety: map any remaining NULLs to 'otro'
UPDATE documentos d
SET tipo_documento_id = (SELECT id FROM tipos_documento WHERE codigo = 'otro')
WHERE d.tipo_documento_id IS NULL;

-- Now enforce NOT NULL
ALTER TABLE documentos ALTER COLUMN tipo_documento_id SET NOT NULL;

-- Make old enum column nullable (backward compat, deprecate later)
ALTER TABLE documentos ALTER COLUMN tipo DROP NOT NULL;

-- Make archivo_url nullable (new records use storage_key instead)
ALTER TABLE documentos ALTER COLUMN archivo_url DROP NOT NULL;

-- ============================================================
-- 6. NEW INDEXES
-- ============================================================

CREATE INDEX idx_documentos_tipo_documento ON documentos(tipo_documento_id);
CREATE INDEX idx_documentos_subido_por     ON documentos(subido_por);
CREATE INDEX idx_documentos_storage_key    ON documentos(storage_key) WHERE storage_key IS NOT NULL;

-- ============================================================
-- 7. TRIGGER for updated_at on documentos
-- ============================================================

CREATE TRIGGER documentos_updated_at
  BEFORE UPDATE ON documentos
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
