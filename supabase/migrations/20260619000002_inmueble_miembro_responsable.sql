-- ============================================================
-- Multi-tenant Fase 3: responsable (miembro) por inmueble
-- ------------------------------------------------------------
-- Permite asignar un MIEMBRO de la inmobiliaria como responsable de un
-- inmueble. Sólo es relevante cuando inmobiliarias.miembros_ven_todo = FALSE:
-- en ese modo, un miembro ve los inmuebles que creó (propietario_id) MÁS los
-- que tiene asignados (miembro_responsable_id). Con miembros_ven_todo = TRUE
-- (default) no cambia nada: todos los miembros ven toda la cartera.
--
-- ON DELETE SET NULL: si se borra el perfil del miembro, el inmueble queda sin
-- responsable (no se borra el inmueble).
-- ============================================================

ALTER TABLE public.inmuebles
  ADD COLUMN IF NOT EXISTS miembro_responsable_id UUID
    REFERENCES public.perfiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_inmuebles_miembro_responsable
  ON public.inmuebles(miembro_responsable_id);

COMMENT ON COLUMN public.inmuebles.miembro_responsable_id IS
  'Miembro de la inmobiliaria responsable del inmueble (Fase 3). Relevante cuando inmobiliarias.miembros_ven_todo=false: el miembro ve lo que creó + lo asignado.';
