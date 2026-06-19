-- ============================================================
-- Multi-tenant Fase 1: organizaciones (inmobiliarias) + miembros
-- ------------------------------------------------------------
-- Hasta ahora una "inmobiliaria" era UN perfil (perfiles.rol='inmobiliaria')
-- y el scoping de datos era por inmuebles.propietario_id = userId. Esto
-- impide que varios usuarios (staff) de una misma agencia compartan la
-- misma cartera de inmuebles / expedientes.
--
-- Esta migración introduce:
--   * inmobiliarias        -> la organización (1 fila por agencia).
--   * inmobiliaria_miembros-> usuarios que pertenecen a una organización
--                             (owner + miembros), con soporte para
--                             invitaciones pendientes (token opaco).
--   * inmuebles.inmobiliaria_id / expedientes.inmobiliaria_id -> a qué
--     organización pertenece el dato (denormalizado para scoping rápido).
--
-- IMPORTANTE: el control de acceso NO usa RLS. El API usa la service_role
-- key que BYPASSA RLS; la autorización vive en la capa de aplicación
-- (middleware authorize/roleGuard + helpers de scoping). Por eso estas
-- tablas NO habilitan RLS, igual que el resto del esquema.
--
-- El backfill es idempotente (puede correrse más de una vez sin duplicar).
-- ============================================================

-- ------------------------------------------------------------
-- 1. Tabla de organizaciones
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.inmobiliarias (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre            VARCHAR(300) NOT NULL,
  owner_perfil_id   UUID NOT NULL REFERENCES public.perfiles(id) ON DELETE CASCADE,
  -- Si TRUE, todos los miembros ven TODA la cartera de la organización
  -- (comportamiento actual de la inmobiliaria de un solo usuario). Si en el
  -- futuro se pone FALSE, los miembros solo verán lo que crean / se les asigne.
  miembros_ven_todo BOOLEAN NOT NULL DEFAULT TRUE,
  estado            VARCHAR(20) NOT NULL DEFAULT 'activa'
                      CHECK (estado IN ('activa', 'suspendida')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inmobiliarias_owner
  ON public.inmobiliarias(owner_perfil_id);

-- ------------------------------------------------------------
-- 2. Miembros de cada organización (incluye invitaciones pendientes)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.inmobiliaria_miembros (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inmobiliaria_id   UUID NOT NULL REFERENCES public.inmobiliarias(id) ON DELETE CASCADE,
  -- NULL mientras la invitación está pendiente (el invitado aún no tiene perfil)
  perfil_id         UUID REFERENCES public.perfiles(id) ON DELETE CASCADE,
  email             VARCHAR(255),                 -- destinatario de la invitación
  rol_miembro       VARCHAR(20) NOT NULL DEFAULT 'miembro'
                      CHECK (rol_miembro IN ('owner', 'miembro')),
  estado            VARCHAR(20) NOT NULL DEFAULT 'invitado'
                      CHECK (estado IN ('activo', 'invitado', 'revocado')),
  token             VARCHAR(64),                  -- token opaco de invitación
  token_expiracion  TIMESTAMPTZ,
  invitado_por      UUID REFERENCES public.perfiles(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Un perfil no puede estar dos veces en la misma organización
CREATE UNIQUE INDEX IF NOT EXISTS idx_inmob_miembro_unico
  ON public.inmobiliaria_miembros(inmobiliaria_id, perfil_id)
  WHERE perfil_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inmob_miembro_perfil
  ON public.inmobiliaria_miembros(perfil_id);
CREATE INDEX IF NOT EXISTS idx_inmob_miembro_inmob
  ON public.inmobiliaria_miembros(inmobiliaria_id);
-- Token único cuando existe (la invitación se busca por token)
CREATE UNIQUE INDEX IF NOT EXISTS idx_inmob_miembro_token
  ON public.inmobiliaria_miembros(token)
  WHERE token IS NOT NULL;

-- ------------------------------------------------------------
-- 3. Columna inmobiliaria_id en los datos scopeables
-- ------------------------------------------------------------
ALTER TABLE public.inmuebles
  ADD COLUMN IF NOT EXISTS inmobiliaria_id UUID
    REFERENCES public.inmobiliarias(id) ON DELETE SET NULL;
ALTER TABLE public.expedientes
  ADD COLUMN IF NOT EXISTS inmobiliaria_id UUID
    REFERENCES public.inmobiliarias(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_inmuebles_inmobiliaria
  ON public.inmuebles(inmobiliaria_id);
CREATE INDEX IF NOT EXISTS idx_expedientes_inmobiliaria
  ON public.expedientes(inmobiliaria_id);

-- ------------------------------------------------------------
-- 4. BACKFILL (idempotente)
-- ------------------------------------------------------------

-- 4a. Una organización por cada perfil con rol='inmobiliaria'.
--     El nombre sale de razon_social; si está vacío, "Nombre Apellido".
INSERT INTO public.inmobiliarias (nombre, owner_perfil_id)
SELECT
  COALESCE(
    NULLIF(TRIM(p.razon_social), ''),
    NULLIF(TRIM(p.nombre || ' ' || p.apellido), ''),
    'Inmobiliaria'
  ),
  p.id
FROM public.perfiles p
WHERE p.rol = 'inmobiliaria'
  AND NOT EXISTS (
    SELECT 1 FROM public.inmobiliarias i WHERE i.owner_perfil_id = p.id
  );

-- 4b. Membresía 'owner' (activo) para el dueño de cada organización.
INSERT INTO public.inmobiliaria_miembros (inmobiliaria_id, perfil_id, rol_miembro, estado)
SELECT i.id, i.owner_perfil_id, 'owner', 'activo'
FROM public.inmobiliarias i
WHERE NOT EXISTS (
  SELECT 1 FROM public.inmobiliaria_miembros m
  WHERE m.inmobiliaria_id = i.id AND m.perfil_id = i.owner_perfil_id
);

-- 4c. Etiquetar inmuebles cuyo propietario_id es el dueño de una organización.
--     (Los inmuebles de propietarios individuales quedan con inmobiliaria_id
--      NULL a propósito: su scoping sigue siendo por propietario_id.)
UPDATE public.inmuebles inm
SET inmobiliaria_id = i.id
FROM public.inmobiliarias i
WHERE inm.propietario_id = i.owner_perfil_id
  AND inm.inmobiliaria_id IS NULL;

-- 4d. Etiquetar expedientes a partir del inmueble (denormalizado).
UPDATE public.expedientes e
SET inmobiliaria_id = inm.inmobiliaria_id
FROM public.inmuebles inm
WHERE e.inmueble_id = inm.id
  AND inm.inmobiliaria_id IS NOT NULL
  AND e.inmobiliaria_id IS NULL;

-- ------------------------------------------------------------
-- 5. Comentarios de documentación
-- ------------------------------------------------------------
COMMENT ON TABLE  public.inmobiliarias IS
  'Organización (agencia) multi-tenant. Agrupa varios perfiles/miembros que comparten la misma cartera de inmuebles y expedientes.';
COMMENT ON TABLE  public.inmobiliaria_miembros IS
  'Pertenencia de un perfil a una organización (owner/miembro). Filas con perfil_id NULL + token son invitaciones pendientes.';
COMMENT ON COLUMN public.inmuebles.inmobiliaria_id IS
  'Organización dueña del inmueble. NULL = inmueble de un propietario individual (scoping por propietario_id).';
COMMENT ON COLUMN public.expedientes.inmobiliaria_id IS
  'Organización dueña del expediente (denormalizado del inmueble al crear). NULL = expediente de propietario individual.';
