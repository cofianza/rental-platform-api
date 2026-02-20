-- ============================================================
-- Migración: Correcciones Code Review HP-164
-- Fecha: 2026-02-19
-- ============================================================

-- AC 1: Cambiar LPAD de 3 a 5 dígitos (INM-00001 en vez de INM-001)
CREATE OR REPLACE FUNCTION generar_codigo_inmueble()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.codigo IS NULL THEN
    NEW.codigo = 'INM-' || LPAD(NEXTVAL('inmueble_codigo_seq')::TEXT, 5, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- AC 3: Agregar 'local_comercial' al enum uso_inmueble y migrar datos
ALTER TYPE uso_inmueble ADD VALUE IF NOT EXISTS 'local_comercial';
