-- ============================================================
-- HOTFIX: handle_new_user falla con "type rol_usuario does not exist"
--
-- Síntoma: TODA alta nueva (inmobiliaria/propietario/solicitante) fallaba con
-- 500 "Database error creating new user". Logs de Auth (GoTrue):
--   ERROR: type "rol_usuario" does not exist (SQLSTATE 42704)
--
-- Causa: el trigger on_auth_user_created -> handle_new_user() se ejecuta en el
-- contexto de GoTrue al crear la fila en auth.users. La función es SECURITY
-- DEFINER pero NO fijaba search_path, así que corría con el search_path del
-- rol de GoTrue (sin 'public'), y el enum public.rol_usuario quedaba sin
-- resolver -> 42704 -> aborta la creación del usuario -> 500.
-- (Regresión introducida al recrear la función en la migración de rol de
-- jun-2026, que quitó el search_path / la calificación de esquema.)
--
-- Fix: SET search_path = public + calificar el tipo como public.rol_usuario.
-- CREATE OR REPLACE: idempotente, no toca datos.
-- ============================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE v_rol public.rol_usuario;
BEGIN
  BEGIN
    v_rol := NULLIF(NEW.raw_user_meta_data->>'rol', '')::public.rol_usuario;
  EXCEPTION WHEN others THEN
    v_rol := NULL;
  END;

  INSERT INTO public.perfiles (id, nombre, apellido, rol, created_at, updated_at)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'nombre', ''),
    COALESCE(NEW.raw_user_meta_data->>'apellido', ''),
    COALESCE(v_rol, 'solicitante'::public.rol_usuario),
    now(), now()
  );

  RETURN NEW;
END;
$function$;
