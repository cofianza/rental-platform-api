-- ============================================================
-- Solicitantes CRUD - Columnas adicionales
-- Tarea: CRUD Solicitantes Backend
-- ============================================================

-- 1. Agregar columna estado para soft delete
ALTER TABLE solicitantes
  ADD COLUMN IF NOT EXISTS estado VARCHAR(20) NOT NULL DEFAULT 'activo';

-- 2. Agregar columna creado_por (usuario que registró al solicitante)
ALTER TABLE solicitantes
  ADD COLUMN IF NOT EXISTS creado_por UUID REFERENCES perfiles(id);

-- 3. Restricción de unicidad: no duplicar tipo_documento + numero_documento
ALTER TABLE solicitantes
  ADD CONSTRAINT solicitantes_documento_unique UNIQUE (tipo_documento, numero_documento);

-- 4. Cambiar default de habitara_inmueble de TRUE a FALSE (requisito: "por defecto: no")
ALTER TABLE solicitantes
  ALTER COLUMN habitara_inmueble SET DEFAULT FALSE;

-- 5. Índice para búsquedas por estado
CREATE INDEX IF NOT EXISTS idx_solicitantes_estado ON solicitantes(estado);

-- 6. Índice para búsquedas por creado_por
CREATE INDEX IF NOT EXISTS idx_solicitantes_creado_por ON solicitantes(creado_por);
