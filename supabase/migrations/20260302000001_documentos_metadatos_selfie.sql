-- ============================================================
-- HP-327: Selfie + Identificacion
-- Agrega campo metadatos JSONB para almacenar info de captura
-- Fecha: 2026-03-02
-- ============================================================

-- ============================================================
-- 1. ADD metadatos COLUMN TO documentos TABLE
-- ============================================================

-- Campo JSONB para almacenar metadatos adicionales del documento
-- Estructura esperada para selfie_con_id:
-- {
--   "metodo_captura": "camara" | "archivo",
--   "timestamp_captura": "2026-03-02T10:30:00Z",
--   "user_agent": "Mozilla/5.0...",
--   "dispositivo": { "tipo": "mobile", "camara": "frontal" }
-- }
ALTER TABLE documentos ADD COLUMN IF NOT EXISTS metadatos JSONB DEFAULT '{}';

-- Index para consultas sobre metadatos especificos
CREATE INDEX IF NOT EXISTS idx_documentos_metadatos ON documentos USING GIN (metadatos);

-- ============================================================
-- 2. COMMENT FOR DOCUMENTATION
-- ============================================================

COMMENT ON COLUMN documentos.metadatos IS 'Metadatos adicionales del documento (ej: metodo_captura, timestamp_captura, user_agent para selfies)';
