-- ============================================================
-- Multi-tenant Fase 3.1: responsable (miembro) por EXPEDIENTE
-- ------------------------------------------------------------
-- Además del responsable por inmueble (20260619000002), permite asignar un
-- miembro de la inmobiliaria como responsable de un EXPEDIENTE puntual,
-- independiente del inmueble. Casos de uso:
--   * Al crear un expediente, el miembro que lo crea queda como responsable.
--   * El titular puede reasignar el responsable de un expediente.
-- Relevante cuando inmobiliarias.miembros_ven_todo = FALSE: el miembro ve los
-- expedientes que le fueron asignados además de los de sus inmuebles.
--
-- ON DELETE SET NULL: si se borra el perfil del miembro, el expediente queda
-- sin responsable (no se borra el expediente).
-- ============================================================

ALTER TABLE public.expedientes
  ADD COLUMN IF NOT EXISTS miembro_responsable_id UUID
    REFERENCES public.perfiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_expedientes_miembro_responsable
  ON public.expedientes(miembro_responsable_id);

COMMENT ON COLUMN public.expedientes.miembro_responsable_id IS
  'Miembro de la inmobiliaria responsable del expediente (Fase 3.1). Relevante cuando inmobiliarias.miembros_ven_todo=false: el miembro ve los expedientes asignados además de los de sus inmuebles.';
