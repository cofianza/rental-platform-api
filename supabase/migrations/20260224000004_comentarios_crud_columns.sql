-- ============================================================
-- Comentarios: Add updated_at and is_internal columns
-- CRUD Comentarios Internos de Expedientes
-- ============================================================

-- 1. Add updated_at column
ALTER TABLE comentarios
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- 2. Backfill existing rows
UPDATE comentarios SET updated_at = created_at WHERE updated_at IS NULL;

-- 3. Set NOT NULL + DEFAULT
ALTER TABLE comentarios
  ALTER COLUMN updated_at SET NOT NULL,
  ALTER COLUMN updated_at SET DEFAULT NOW();

-- 4. Add is_internal column (default true, future toggle)
ALTER TABLE comentarios
  ADD COLUMN IF NOT EXISTS is_internal BOOLEAN NOT NULL DEFAULT TRUE;

-- 5. Auto-update trigger for updated_at
CREATE OR REPLACE FUNCTION update_comentarios_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_comentarios_updated_at ON comentarios;
CREATE TRIGGER trg_comentarios_updated_at
  BEFORE UPDATE ON comentarios
  FOR EACH ROW
  EXECUTE FUNCTION update_comentarios_updated_at();
