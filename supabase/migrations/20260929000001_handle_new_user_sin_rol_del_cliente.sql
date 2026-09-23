-- ============================================================
-- SEGURIDAD: handle_new_user tomaba el ROL de raw_user_meta_data
--
-- raw_user_meta_data es lo que el cliente manda en `options.data` al
-- registrarse directo contra Supabase (/auth/v1/signup con la llave anon, que
-- es pública en la web). Con `data: { rol: 'administrador' }` cualquiera
-- obtenía una cuenta de administrador (perfiles.estado nace 'activo'), y el
-- API toma el rol de perfiles sin mirar cómo se creó la cuenta.
--
-- Fix: el trigger ya no lee el rol del cliente; toda cuenta nace
-- 'solicitante'. Los cinco caminos del API que crean usuarios (registro de
-- propietario e inmobiliaria, alta desde el panel, vitrina e invitación de
-- miembro) ya hacen UPDATE de perfiles.rol justo después de createUser, así
-- que no cambian. Si ese UPDATE fallara, la cuenta queda como solicitante
-- (el caso seguro).
--
-- CREATE OR REPLACE: idempotente, no toca datos. Mantiene SET search_path
-- (ver 20260707000001: sin él, toda alta caía con 500).
-- ============================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  INSERT INTO public.perfiles (id, nombre, apellido, rol, created_at, updated_at)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'nombre', ''),
    COALESCE(NEW.raw_user_meta_data->>'apellido', ''),
    'solicitante'::public.rol_usuario,
    now(), now()
  );

  RETURN NEW;
END;
$function$;

-- Verificación (debe devolver false: la función ya no menciona 'rol' del metadata):
-- SELECT position('raw_user_meta_data->>''rol''' IN pg_get_functiondef('public.handle_new_user'::regproc)) > 0;
