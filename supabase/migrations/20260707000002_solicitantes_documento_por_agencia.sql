-- Tarea 3.1 — Documento de solicitante único POR AGENCIA (no global).
--
-- Problema: solicitantes_documento_unique UNIQUE(tipo_documento, numero_documento)
-- era GLOBAL en toda la plataforma, así que si una inmobiliaria A registraba a
-- una persona, la inmobiliaria B NO podía crear su propia ficha de esa persona
-- (error DOCUMENTO_DUPLICADO). En un modelo multi-tenant cada agencia debe tener
-- su propia ficha (no se comparte PII entre agencias), y una persona puede
-- solicitar inmuebles en varias agencias.
--
-- Solución: acotar la unicidad del documento a la ORGANIZACIÓN (inmobiliaria_id)
-- o, para propietarios individuales / roles internos sin organización, al
-- creador (creado_por). Dentro de la misma agencia se sigue reutilizando la
-- ficha (una persona = una ficha por agencia).

-- 1. Columna denormalizada de organización (mismo patrón que inmuebles/expedientes).
ALTER TABLE solicitantes
  ADD COLUMN IF NOT EXISTS inmobiliaria_id uuid REFERENCES inmobiliarias(id) ON DELETE SET NULL;

-- 2. Backfill: la organización activa del creador (Fase 1: a lo sumo una).
--    Propietarios individuales / admin quedan con inmobiliaria_id NULL (se
--    acotan por creado_por vía el COALESCE del índice de abajo).
UPDATE solicitantes s
SET inmobiliaria_id = m.inmobiliaria_id
FROM inmobiliaria_miembros m
WHERE s.creado_por IS NOT NULL
  AND m.perfil_id = s.creado_por
  AND m.estado = 'activo'
  AND s.inmobiliaria_id IS NULL;

-- 3. Quitar el unique GLOBAL y crear el unique POR AGENCIA.
--    COALESCE(inmobiliaria_id, creado_por) = "scope del tenant": la organización
--    si el solicitante pertenece a una, o el creador (propietario/interno) si no.
--    Como el unique global anterior garantizaba documentos únicos en toda la
--    base, este índice (más permisivo) no puede tener conflictos al crearse.
ALTER TABLE solicitantes DROP CONSTRAINT IF EXISTS solicitantes_documento_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_solicitantes_documento_por_agencia
  ON solicitantes (COALESCE(inmobiliaria_id, creado_por), tipo_documento, numero_documento);

CREATE INDEX IF NOT EXISTS idx_solicitantes_inmobiliaria ON solicitantes(inmobiliaria_id);

COMMENT ON COLUMN solicitantes.inmobiliaria_id IS
  'Organización dueña de la ficha (denormalizado). Acota la unicidad del documento por agencia (tarea 3.1). NULL para propietarios individuales / roles internos.';
