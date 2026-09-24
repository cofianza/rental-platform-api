-- ============================================================
-- Equipos: una persona pertenece a una sola inmobiliaria a la vez.
--
-- vincularMiembro (aceptar o registrarse con una invitación) ya responde 409
-- YA_PERTENECE_A_OTRA_INMOBILIARIA si la persona está activa en otra
-- organización; este índice cubre dos aceptaciones simultáneas y cualquier
-- escritura que no pase por ese camino. Las invitaciones pendientes (sin
-- perfil) y las membresías revocadas no cuentan.
--
-- Opcional: el API funciona igual con o sin el índice. Al 2026-09-24 ningún
-- perfil tenía dos membresías activas (6 activas en total), así que no hay
-- duplicados que limpiar. Si el índice fallara por duplicados, esta consulta
-- los muestra:
--   SELECT perfil_id, array_agg(inmobiliaria_id)
--   FROM inmobiliaria_miembros
--   WHERE estado = 'activo' AND perfil_id IS NOT NULL
--   GROUP BY perfil_id HAVING count(*) > 1;
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_inmob_miembro_una_activa_por_perfil
  ON public.inmobiliaria_miembros (perfil_id)
  WHERE estado = 'activo' AND perfil_id IS NOT NULL;
