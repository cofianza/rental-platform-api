-- ============================================================
-- Fix: eliminar los OVERLOADS viejos de list_expedientes_with_relations.
--
-- La migración 20260623000001 agregó la versión con p_estudio_filtro (11 args)
-- vía CREATE OR REPLACE. Pero como cambiar el nº de args cambia la FIRMA, no
-- reemplazó las versiones anteriores (9 y 10 args) — quedaron COEXISTIENDO.
-- Resultado: una llamada con 10 args queda AMBIGUA entre la versión de 10 args
-- (match exacto) y la de 11 args (p_estudio_filtro por default) → PostgREST
-- responde "Could not choose the best candidate function" y el listado de
-- expedientes falla en todos los roles.
--
-- Solución: dejar SOLO la versión de 11 args (la más nueva, con estudio_vigente
-- y el filtro). Las llamadas con 9/10 args resuelven a ella usando defaults.
-- ============================================================

-- Versión vieja de 9 args (sin p_inmueble_id).
DROP FUNCTION IF EXISTS list_expedientes_with_relations(
  text, text[], uuid, timestamptz, timestamptz, text, text, integer, integer
);

-- Versión de 10 args (con p_inmueble_id, sin p_estudio_filtro).
DROP FUNCTION IF EXISTS list_expedientes_with_relations(
  text, text[], uuid, uuid, timestamptz, timestamptz, text, text, integer, integer
);
