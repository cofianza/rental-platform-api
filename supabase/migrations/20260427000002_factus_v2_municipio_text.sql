-- ============================================================
-- Factus V2: municipio_id pasa de INT a TEXT.
--
-- En V2 Factus exige el código DANE (5 dígitos, ej. "05001" para Medellín
-- — con cero a la izquierda), no su ID interno. Almacenar como TEXT preserva
-- los ceros a la izquierda y evita conversiones implícitas.
-- ============================================================

-- Convertir tipo (los datos previos eran IDs internos de Factus V1; los
-- transformamos a string sin pérdida — si están vacíos quedan NULL).
ALTER TABLE solicitantes
  ALTER COLUMN municipio_id TYPE TEXT USING municipio_id::TEXT;

COMMENT ON COLUMN solicitantes.municipio_id IS 'Código DANE del municipio (5 dígitos, ej. "11001" Bogotá, "05001" Medellín). Requerido por Factus V2 como municipality_code.';
