-- ============================================================
-- autorizacion_perfil_prospecto.biometria — cotejo AucoFace (Politica V4.1)
-- ------------------------------------------------------------
-- Anexo A de la Politica pide, en las CINCO categorias de perfil, "Cedula de
-- ciudadania (validada via biometria AUCO o equivalente) — Obligatorio", y el
-- §14 remata: "API biometria / Registraduria no responde -> REVISION MANUAL
-- OBLIGATORIA. No aprobar automaticamente sin validacion de identidad."
--
-- Guarda el VEREDICTO, no las fotos: estado, similitud, umbral aplicado, el
-- `code` del proceso en Auco (con el que Auco reproduce la evidencia si alguna
-- vez se cuestiona) y el numero de documento leido por OCR ENMASCARADO.
--
-- POR QUE NO SE GUARDAN LAS IMAGENES. La selfie es dato biometrico =
-- SENSIBLE (Ley 1581 art. 5). Guardarla multiplicaria el dano de cualquier
-- filtracion sin agregar nada que el `code` no de: Auco ya las custodia como
-- encargado. Principio de minimizacion (art. 4-c).
--
-- POR QUE AQUI Y NO EN `estudios`. Esta tabla ya es la casa del PASO 5 del
-- Flujo (§8.1 identidad, §8.2 ingreso, §8.3 acompanante) y es 1:1 con el
-- EXPEDIENTE: reenviar el enlace no pierde ni duplica lo ya verificado, igual
-- que con el resto del paso. El cotejo ocurre ANTES de que exista un resultado
-- de estudio, asi que colgarlo del estudio obligaria a un backfill.
--
-- NO DECIDE NADA POR SI SOLA: la columna solo se llena si
-- AUCO_BIOMETRIA_ENABLED=true, y aun llena nunca produce un rechazo — como
-- mucho baja un 'aprobado' a 'condicionado' (revision manual). Ver el
-- encabezado de src/modules/autorizaciones/biometria.ts.
-- ============================================================

ALTER TABLE public.autorizacion_perfil_prospecto
  ADD COLUMN IF NOT EXISTS biometria JSONB;

COMMENT ON COLUMN public.autorizacion_perfil_prospecto.biometria IS
  'Veredicto del cotejo biometrico AucoFace (estado, similitud, umbral, code del proceso, documento OCR enmascarado). NUNCA contiene las imagenes. NULL = no se pidio. Ver src/modules/autorizaciones/biometria.ts.';

-- Solo los estados del vocabulario, y coherencia entre estado y similitud:
-- 'verificada' y 'no_coincide' salen SIEMPRE de un cotejo con porcentaje; los
-- otros tres son ausencia de cotejo y no pueden traer uno.
ALTER TABLE public.autorizacion_perfil_prospecto
  DROP CONSTRAINT IF EXISTS chk_perfil_prospecto_biometria;

ALTER TABLE public.autorizacion_perfil_prospecto
  ADD CONSTRAINT chk_perfil_prospecto_biometria CHECK (
    biometria IS NULL
    OR (
      biometria->>'estado' IN ('verificada','no_coincide','no_verificada','omitida','desactivada')
      AND (
        biometria->>'estado' NOT IN ('verificada','no_coincide')
        OR jsonb_typeof(biometria->'similitud') = 'number'
      )
    )
  );

-- ------------------------------------------------------------
-- ROLLBACK (manual, no se ejecuta aqui)
--
--   ALTER TABLE public.autorizacion_perfil_prospecto
--     DROP CONSTRAINT IF EXISTS chk_perfil_prospecto_biometria;
--   ALTER TABLE public.autorizacion_perfil_prospecto
--     DROP COLUMN IF EXISTS biometria;
