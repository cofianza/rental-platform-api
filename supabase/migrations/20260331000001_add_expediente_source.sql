-- HP-368: Add source column to expedientes for tracking origin
ALTER TABLE expedientes ADD COLUMN IF NOT EXISTS source VARCHAR(50) DEFAULT 'manual';
COMMENT ON COLUMN expedientes.source IS 'Origin of the expediente: manual, vitrina_publica';
