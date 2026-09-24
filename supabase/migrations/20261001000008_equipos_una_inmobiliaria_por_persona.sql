-- ============================================================
-- Equipos: una persona pertenece a una sola inmobiliaria a la vez.
--
-- SE DEBE CORRER. El API funciona antes y después, pero sin ella el chequeo de
-- la API no frena dos aceptaciones simultáneas (una persona puede quedar en
-- dos inmobiliarias) y el cierre no queda marcado (la inmobiliaria cerrada
-- sigue contando en el dashboard). Idempotente.
--
-- 1. Índice único parcial. vincularMiembro (aceptar o registrarse con una
--    invitación) ya responde 409 YA_PERTENECE_A_OTRA_INMOBILIARIA si la persona
--    está activa en otra organización; el índice cubre dos aceptaciones
--    simultáneas (la API convierte su 23505 en el mismo 409) y cualquier
--    escritura que no pase por ese camino. Las invitaciones pendientes (sin
--    perfil) y las membresías revocadas no cuentan.
--    Al 2026-09-24 ningún perfil tenía dos membresías activas (6 activas en
--    total), así que no hay duplicados que limpiar. Si el índice fallara por
--    duplicados, esta consulta los muestra:
--      SELECT perfil_id, array_agg(inmobiliaria_id)
--      FROM inmobiliaria_miembros
--      WHERE estado = 'activo' AND perfil_id IS NOT NULL
--      GROUP BY perfil_id HAVING count(*) > 1;
--
-- 2. Estado 'cerrada'. Cuando el titular único de una inmobiliaria vacía (sin
--    equipo, inmuebles, estudios en curso, fichas, créditos ni compras
--    pendientes) la cierra al salir (salirDeOrg), la API revoca su membresía y
--    las invitaciones pendientes y la marca 'cerrada', sin borrar filas. Sin
--    esta parte la marca falla con un aviso en el log (quedan la membresía
--    revocada y la constancia en la bitácora).
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_inmob_miembro_una_activa_por_perfil
  ON public.inmobiliaria_miembros (perfil_id)
  WHERE estado = 'activo' AND perfil_id IS NOT NULL;

ALTER TABLE public.inmobiliarias DROP CONSTRAINT IF EXISTS inmobiliarias_estado_check;
ALTER TABLE public.inmobiliarias
  ADD CONSTRAINT inmobiliarias_estado_check CHECK (estado IN ('activa', 'suspendida', 'cerrada'));
