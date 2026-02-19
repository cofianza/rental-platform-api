-- ============================================================
-- Habitar Propiedades 2.0 - Fotos de Inmuebles
-- Base de datos: Supabase PostgreSQL
-- Fecha: 2026-02-19
-- Tarea: HP-203 - Inventario digital del inmueble (fotos)
-- ============================================================

-- ============================================================
-- 1. TABLA FOTOS_INMUEBLE
-- ============================================================

CREATE TABLE fotos_inmueble (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inmueble_id     UUID NOT NULL REFERENCES inmuebles(id) ON DELETE CASCADE,
  url             TEXT NOT NULL,
  url_thumbnail   TEXT,
  descripcion     VARCHAR(500),
  orden           SMALLINT NOT NULL DEFAULT 0,
  es_fachada      BOOLEAN NOT NULL DEFAULT FALSE,
  tamaño_archivo  INTEGER,
  tipo_archivo    VARCHAR(50),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 2. ÍNDICES
-- ============================================================

CREATE INDEX idx_fotos_inmueble_inmueble ON fotos_inmueble(inmueble_id);
CREATE INDEX idx_fotos_inmueble_orden ON fotos_inmueble(inmueble_id, orden);
CREATE INDEX idx_fotos_inmueble_fachada ON fotos_inmueble(inmueble_id, es_fachada) WHERE es_fachada = TRUE;

-- ============================================================
-- 3. ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE fotos_inmueble ENABLE ROW LEVEL SECURITY;

-- Sin políticas temporales: con RLS habilitado y sin políticas,
-- solo service_role (que omite RLS) puede acceder a los datos.
-- Esto es seguro porque el backend usa exclusivamente la clave service_role.

-- ============================================================
-- 4. CONFIGURACIÓN DE STORAGE (comentado, ejecutar manualmente en Supabase Dashboard)
-- ============================================================

-- Crear bucket para fotos de inmuebles si no existe
-- INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
-- VALUES (
--   'inmuebles-fotos',
--   'inmuebles-fotos',
--   true,
--   5242880, -- 5MB
--   ARRAY['image/jpeg', 'image/png', 'image/webp']
-- )
-- ON CONFLICT (id) DO NOTHING;

-- Política para permitir lectura pública de fotos
-- CREATE POLICY "Fotos públicas de inmuebles"
-- ON storage.objects FOR SELECT
-- USING (bucket_id = 'inmuebles-fotos');

-- Política para permitir subida de fotos por usuarios autenticados
-- CREATE POLICY "Usuarios autenticados pueden subir fotos"
-- ON storage.objects FOR INSERT
-- TO authenticated
-- WITH CHECK (bucket_id = 'inmuebles-fotos');

-- Política para permitir eliminación de fotos por usuarios autenticados
-- CREATE POLICY "Usuarios autenticados pueden eliminar fotos"
-- ON storage.objects FOR DELETE
-- TO authenticated
-- USING (bucket_id = 'inmuebles-fotos');
