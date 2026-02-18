-- ============================================================
-- Migracion: Nuevas columnas y enum para inmuebles
-- Fecha: 2026-02-18
-- ============================================================

-- 1. Agregar valor 'bodega' al enum tipo_inmueble
ALTER TYPE tipo_inmueble ADD VALUE IF NOT EXISTS 'bodega';

-- 2. Agregar nuevas columnas a inmuebles
ALTER TABLE inmuebles ADD COLUMN IF NOT EXISTS destinacion    TEXT;
ALTER TABLE inmuebles ADD COLUMN IF NOT EXISTS codigo_postal  VARCHAR(10);
ALTER TABLE inmuebles ADD COLUMN IF NOT EXISTS latitud        NUMERIC(10,7);
ALTER TABLE inmuebles ADD COLUMN IF NOT EXISTS longitud       NUMERIC(10,7);
ALTER TABLE inmuebles ADD COLUMN IF NOT EXISTS parqueaderos   SMALLINT DEFAULT 0;
ALTER TABLE inmuebles ADD COLUMN IF NOT EXISTS piso           VARCHAR(10);
