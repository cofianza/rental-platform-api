-- ============================================================
-- Miembros de inmobiliaria: rol "solo lectura" + co-titularidad
-- ------------------------------------------------------------
-- Amplía el CHECK de inmobiliaria_miembros.rol_miembro para admitir un tercer
-- nivel 'solo_lectura' (viewer): ve el equipo y la cartera pero NO puede
-- crear / editar / borrar datos (el bloqueo de escritura vive en la capa de
-- aplicación, en authMiddleware).
--
-- La co-titularidad (varios 'owner' por organización) y la transferencia de
-- titularidad NO requieren cambios de esquema: ya se modelan con varias filas
-- rol_miembro='owner' activas. inmobiliarias.owner_perfil_id se mantiene como
-- "titular principal" y la app lo re-apunta a otro owner activo si el titular
-- se degrada o sale. Los checks de ownership (esOwnerDeOrg) ya consultan
-- rol_miembro='owner' sin asumir unicidad.
--
-- IMPORTANTE: el control de acceso NO usa RLS (service_role bypassa RLS); este
-- cambio es sólo la restricción de integridad del valor permitido.
-- ============================================================

-- Elimina CUALQUIER CHECK existente sobre rol_miembro (el original tiene nombre
-- autogenerado; borrarlo por nombre fijo sería frágil y podría dejar el viejo
-- constraint rechazando 'solo_lectura'). Robust + idempotente.
DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'inmobiliaria_miembros'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%rol_miembro%'
  LOOP
    EXECUTE format('ALTER TABLE public.inmobiliaria_miembros DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.inmobiliaria_miembros
  ADD CONSTRAINT inmobiliaria_miembros_rol_miembro_check
  CHECK (rol_miembro IN ('owner', 'miembro', 'solo_lectura'));

COMMENT ON COLUMN public.inmobiliaria_miembros.rol_miembro IS
  'owner = titular (puede gestionar equipo y datos; puede haber varios = co-titulares). miembro = staff operativo (crea/edita datos de la org). solo_lectura = viewer (sólo lectura; sin escritura).';
