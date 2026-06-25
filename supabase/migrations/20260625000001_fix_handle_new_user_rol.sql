-- ============================================================
-- Fix: handle_new_user() no asignaba `rol` → cuentas quedaban operador_analista
-- ------------------------------------------------------------
-- El trigger DESPLEGADO en la BD había derivado (drift respecto al repo) a una
-- versión que solo insertaba (id, nombre, apellido) y NO `rol`. Por eso `rol`
-- caía al DEFAULT de la columna `perfiles.rol` = 'operador_analista' (rol interno
-- de staff con visibilidad 'all'). Cualquier alta que no pasara por un flujo de
-- registro que hiciera el UPDATE correctivo (o cuyo UPDATE fallara) quedaba como
-- operador_analista + estado activo → escalamiento de privilegios y fuga
-- cross-tenant (un usuario externo veía datos de TODAS las agencias).
--
-- Este fix:
--   1) Restaura el trigger para que LEA el rol del metadata del usuario.
--   2) Cambia el fallback (y el DEFAULT de columna) a 'solicitante' = mínimo
--      privilegio. Así una alta sin rol explícito nunca cae en un rol interno.
--   3) Backfill SEGURO: corrige las cuentas ya afectadas (rol='operador_analista'
--      pero cuyo metadata indica un rol externo).
--
-- Idempotente. El control de acceso vive en la capa de app (service_role bypassa
-- RLS), pero el rol correcto es la base del scoping → este fix es de seguridad.
-- ============================================================

-- 1) DEFAULT de columna ya no es un rol interno.
ALTER TABLE public.perfiles ALTER COLUMN rol SET DEFAULT 'solicitante';

-- 2) Trigger lee el rol del metadata (con cast seguro); si falta/inválido →
--    'solicitante'. Mantiene SECURITY DEFINER (escribe en public.perfiles desde
--    un trigger sobre auth.users).
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_rol rol_usuario;
BEGIN
  BEGIN
    v_rol := NULLIF(NEW.raw_user_meta_data->>'rol', '')::rol_usuario;
  EXCEPTION WHEN others THEN
    v_rol := NULL;
  END;

  INSERT INTO public.perfiles (id, nombre, apellido, rol, created_at, updated_at)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'nombre', ''),
    COALESCE(NEW.raw_user_meta_data->>'apellido', ''),
    COALESCE(v_rol, 'solicitante'),
    now(),
    now()
  );
  RETURN NEW;
END;
$$;

-- (El trigger on_auth_user_created ya apunta a esta función; CREATE OR REPLACE
--  la actualiza in-place, no hace falta recrear el trigger.)

-- 3) Backfill seguro de víctimas: solo toca filas operador_analista cuyo metadata
--    declara un rol EXTERNO (inmobiliaria/propietario/solicitante). No toca un
--    operador_analista legítimo (su metadata.rol sería operador_analista o NULL).
UPDATE public.perfiles p
SET rol = (u.raw_user_meta_data->>'rol')::rol_usuario,
    updated_at = now()
FROM auth.users u
WHERE u.id = p.id
  AND p.rol = 'operador_analista'
  AND (u.raw_user_meta_data->>'rol') IN ('inmobiliaria', 'propietario', 'solicitante');
