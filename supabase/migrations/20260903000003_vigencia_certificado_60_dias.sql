-- ============================================================
-- Vigencia del Certificado de Riesgo Cofianza (CRC): 30 -> 60 dias
-- ------------------------------------------------------------
-- Gerencia (Direccion de Riesgo, 2026-09-03) resolvio por escrito la
-- contradiccion entre los dos documentos: el Flujo del modulo de estudios §14
-- dice "Vigencia del estudio aprobado. 60 dias" y la Politica de Evaluacion
-- V4.1 §8 decia 90 dias para el CRC. Respuesta literal: "60 dias". Manda el
-- Flujo. El sistema estaba en 30.
--
-- POR QUE HACE FALTA ESTA MIGRACION Y NO BASTA CAMBIAR EL CODIGO:
-- getCompany() (src/lib/companyConfig.ts) mezcla la fila
-- configuracion_sistema.clave='empresa' ENCIMA de los defaults de
-- src/config/company.ts:
--     const value = { ...DEFAULTS, ...stored };
-- O sea que la BD GANA. Cambiar solo company.ts deja los certificados
-- generandose con los 30 dias que trae la fila. Verificado en produccion: la
-- fila existe (se sembro en 20260622000003 y despues se edito desde el panel
-- con el NIT real), y trae certificateValidityDays = 30.
--
-- Alcance: solo esa clave. `valor` es un TEXT con el JSON completo de la
-- empresa (name, nit, address, phone, email, website, certificateValidityDays),
-- asi que se hace un MERGE de jsonb (`||`) en vez de reescribir el objeto: el
-- NIT real (902.038.122-7), la direccion y el correo confirmados por el cliente
-- NO se tocan. Un INSERT ... ON CONFLICT DO UPDATE con el objeto completo los
-- habria pisado con los valores de placeholder del seed original.
--
-- Idempotente: si ya esta en 60, no escribe. Si la fila no existe, no hace nada
-- (sin fila, getCompany() cae a los defaults de company.ts, que ya dicen 60).
--
-- Efecto: solo hacia adelante. Los certificados ya emitidos conservan su
-- fecha_vencimiento congelada en estudios_certificados; esta migracion no los
-- reescribe. Los que se emitan (o se regeneren) despues salen con 60 dias.
--
-- Verificar despues de correrla:
--   SELECT valor::jsonb ->> 'certificateValidityDays' FROM configuracion_sistema
--    WHERE clave = 'empresa';   -- debe devolver 60
-- getCompany() cachea 60 s en memoria: el cambio se ve al minuto (o al
-- siguiente deploy, o guardando cualquier campo en /configuracion/empresa,
-- que llama a invalidateCompanyCache()).
-- ============================================================

DO $$
DECLARE
  v_valor TEXT;
  v_json  JSONB;
BEGIN
  SELECT valor INTO v_valor
    FROM public.configuracion_sistema
   WHERE clave = 'empresa';

  IF v_valor IS NULL THEN
    RAISE NOTICE 'configuracion_sistema.empresa no existe: getCompany() usa los defaults de src/config/company.ts (ya en 60). Nada que actualizar.';
    RETURN;
  END IF;

  -- El cast se hace aparte y no en el WHERE: Postgres no garantiza el orden de
  -- evaluacion de las condiciones, asi que un `valor` no-JSON podia reventar la
  -- migracion antes de filtrar por clave.
  BEGIN
    v_json := v_valor::jsonb;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'configuracion_sistema.empresa no contiene JSON valido (%). Corregir la fila a mano antes de correr esta migracion.', left(v_valor, 120);
  END;

  IF jsonb_typeof(v_json) <> 'object' THEN
    RAISE EXCEPTION 'configuracion_sistema.empresa no es un objeto JSON (es %). Corregir la fila a mano.', jsonb_typeof(v_json);
  END IF;

  IF v_json ->> 'certificateValidityDays' = '60' THEN
    RAISE NOTICE 'configuracion_sistema.empresa ya tiene certificateValidityDays = 60. Sin cambios.';
    RETURN;
  END IF;

  UPDATE public.configuracion_sistema
     SET valor = (v_json || jsonb_build_object('certificateValidityDays', 60))::text,
         updated_at = NOW()
   WHERE clave = 'empresa';

  RAISE NOTICE 'configuracion_sistema.empresa: certificateValidityDays % -> 60 (el resto del objeto queda intacto).',
    COALESCE(v_json ->> 'certificateValidityDays', 'ausente');
END $$;

COMMENT ON TABLE public.configuracion_sistema IS
  'Configuracion editable por el administrador. La clave ''empresa'' guarda un JSON con los datos de Cofianza; getCompany() lo mezcla ENCIMA de los defaults de src/config/company.ts, asi que esta fila GANA sobre el codigo.';
