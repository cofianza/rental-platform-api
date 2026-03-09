-- ============================================================
-- Plantillas de Contrato: ALTER TABLE
-- Renames contenido_url → contenido (HTML text direct)
-- Adds version (smallint) and creado_por (FK perfiles)
-- ============================================================

-- 1. Rename column contenido_url → contenido
ALTER TABLE plantillas_contrato
  RENAME COLUMN contenido_url TO contenido;

-- 2. Add version column
ALTER TABLE plantillas_contrato
  ADD COLUMN version SMALLINT NOT NULL DEFAULT 1;

-- 3. Add creado_por FK
ALTER TABLE plantillas_contrato
  ADD COLUMN creado_por UUID REFERENCES perfiles(id) ON DELETE SET NULL;

-- 4. Indexes
CREATE INDEX idx_plantillas_creado_por
  ON plantillas_contrato(creado_por);

CREATE INDEX idx_plantillas_activa
  ON plantillas_contrato(activa)
  WHERE activa = TRUE;
