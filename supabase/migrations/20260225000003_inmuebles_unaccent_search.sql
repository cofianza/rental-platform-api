-- ============================================================
-- Búsqueda de inmuebles insensible a acentos/diacríticos
-- Habilita unaccent y crea RPC auxiliar para búsqueda por texto
-- ============================================================

CREATE EXTENSION IF NOT EXISTS unaccent;

-- Retorna IDs de inmuebles que coinciden con el término de búsqueda
-- usando unaccent() para ignorar tildes (Medellin = Medellín)
CREATE OR REPLACE FUNCTION search_inmueble_ids(p_search TEXT)
RETURNS TABLE(id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT i.id
  FROM inmuebles i
  WHERE unaccent(lower(i.direccion)) LIKE '%' || unaccent(lower(p_search)) || '%'
     OR unaccent(lower(i.ciudad)) LIKE '%' || unaccent(lower(p_search)) || '%'
     OR unaccent(lower(coalesce(i.barrio, ''))) LIKE '%' || unaccent(lower(p_search)) || '%'
     OR lower(i.codigo) LIKE '%' || lower(p_search) || '%';
$$;
