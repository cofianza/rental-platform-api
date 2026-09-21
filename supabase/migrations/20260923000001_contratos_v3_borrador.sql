-- ============================================================
-- Contratos V3 — Entrega 3: documento del representante legal, un contrato V3 vivo por
-- estudio, filas V3 congeladas fuera de borrador, partes editables solo en borrador.
-- Idempotente. La corre el usuario ANTES del push de la API (el perfil lee las columnas nuevas).
-- Legacy V1/V4 (destinacion NULL) no cambia: el indice y el congelado solo miran filas V3.
-- ============================================================

ALTER TABLE public.perfiles
  ADD COLUMN IF NOT EXISTS representante_legal_tipo_documento VARCHAR(10),
  ADD COLUMN IF NOT EXISTS representante_legal_documento      VARCHAR(30);
ALTER TABLE public.perfiles DROP CONSTRAINT IF EXISTS perfiles_rep_legal_doc_chk;
ALTER TABLE public.perfiles ADD CONSTRAINT perfiles_rep_legal_doc_chk CHECK (
  (representante_legal_tipo_documento IS NULL) = (representante_legal_documento IS NULL)
  AND (representante_legal_tipo_documento IS NULL OR representante_legal_tipo_documento IN ('cc','ce','pasaporte'))
  AND (representante_legal_documento IS NULL OR representante_legal_documento ~ '^[A-Za-z0-9]{3,30}$'));

-- Un solo contrato V3 vivo por estudio: Iniciar idempotente, sin quemar consecutivos.
CREATE UNIQUE INDEX IF NOT EXISTS contratos_v3_vivo_uq ON public.contratos (expediente_id)
  WHERE destinacion IS NOT NULL AND estado NOT IN ('cancelado','finalizado');

-- Fuera de borrador una fila V3 solo cambia estado, firma y terminación (deny-by-default).
CREATE OR REPLACE FUNCTION public.fn_contratos_v3_congelado() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_libres CONSTANT TEXT[] := ARRAY['estado','updated_at','fecha_firma','fecha_terminacion',
  'motivo_cancelacion','storage_key_firmado','nombre_archivo_firmado','firmado_storage_key',
  'firmado_nombre_archivo','firmado_hash_integridad','firmado_ip','firmado_user_agent',
  'firmado_referencia_otp','firmado_notas','firmado_tamano_bytes','firmado_subido_por',
  'firmado_subido_en','generado_por','contrato_padre_id'];  -- incluye las 3 FK ON DELETE SET NULL
BEGIN
  IF (to_jsonb(NEW) - v_libres) IS DISTINCT FROM (to_jsonb(OLD) - v_libres) THEN
    RAISE EXCEPTION 'Contrato % congelado: fuera de borrador solo cambian estado, firma y terminación',
      OLD.numero USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS contratos_v3_congelado ON public.contratos;
-- AFTER: base_calculo_fianza_cop (generada) ya está calculada; en BEFORE no se puede leer.
CREATE TRIGGER contratos_v3_congelado AFTER UPDATE ON public.contratos
  FOR EACH ROW WHEN (OLD.destinacion IS NOT NULL AND OLD.estado <> 'borrador')
  EXECUTE FUNCTION public.fn_contratos_v3_congelado();

-- contrato_partes: solo con el contrato (origen y destino) en borrador.
CREATE OR REPLACE FUNCTION public.fn_contrato_partes_solo_borrador() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  -- estudio_id ON DELETE SET NULL (y su updated_at) no es editar la parte.
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - ARRAY['estudio_id','updated_at'])
                        = (to_jsonb(OLD) - ARRAY['estudio_id','updated_at']) THEN
    RETURN NEW;
  END IF;
  -- Padre inexistente = borrado en cascada (fn_wipe_test_data): permitido.
  IF EXISTS (SELECT 1 FROM public.contratos c WHERE c.estado <> 'borrador' AND c.id IN (
       CASE WHEN TG_OP <> 'INSERT' THEN OLD.contrato_id END,
       CASE WHEN TG_OP <> 'DELETE' THEN NEW.contrato_id END)) THEN
    RAISE EXCEPTION 'contrato_partes: el contrato ya no está en borrador' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS contrato_partes_solo_borrador ON public.contrato_partes;
CREATE TRIGGER contrato_partes_solo_borrador BEFORE INSERT OR UPDATE OR DELETE ON public.contrato_partes
  FOR EACH ROW EXECUTE FUNCTION public.fn_contrato_partes_solo_borrador();

-- Verificacion manual (despues de correrla; no deja rastro). Pegar completo en el
-- SQL editor: cada error esperado se atrapa; si algo no cuadra aborta con "FALLA (x)".
-- Al final debe salir el NOTICE "Verificacion E3: todo OK".
--   BEGIN;
--   DO $v$
--   DECLARE
--     e UUID := (SELECT id FROM expedientes LIMIT 1);
--     c UUID; n TEXT; p UUID;
--   BEGIN
--     -- (a) la fila V3 recibe numero; un segundo V3 vivo en el mismo estudio → 23505
--     INSERT INTO contratos (expediente_id, estado, destinacion, iva_canon_pct, datos_variables)
--       VALUES (e, 'borrador', 'vivienda', 0, '{"asistente":{}}') RETURNING id, numero INTO c, n;
--     ASSERT n IS NOT NULL, 'FALLA (a): la fila V3 no recibio numero';
--     BEGIN
--       INSERT INTO contratos (expediente_id, destinacion, iva_canon_pct) VALUES (e, 'vivienda', 0);
--       RAISE EXCEPTION 'FALLA (a): se acepto un segundo contrato V3 vivo';
--     EXCEPTION WHEN unique_violation THEN NULL;
--     END;
--     -- (b) en borrador se edita datos_variables
--     UPDATE contratos SET datos_variables = '{"asistente":{"paso4":{"omitir":true}}}' WHERE id = c;
--     INSERT INTO contrato_partes (contrato_id, rol, orden, nombre, tipo_documento, numero_documento, estudio_id)
--       VALUES (c, 'arrendatario', 1, 'Prueba', 'cc', '123456', (SELECT id FROM estudios LIMIT 1))
--       RETURNING id INTO p;
--     -- (c) cancelado: terminacion y FK SET NULL pasan; el canon no
--     UPDATE contratos SET estado = 'cancelado' WHERE id = c;
--     UPDATE contratos SET motivo_cancelacion = 'Prueba', fecha_terminacion = now() WHERE id = c;
--     UPDATE contratos SET generado_por = NULL WHERE id = c;
--     BEGIN
--       UPDATE contratos SET valor_arriendo = 1 WHERE id = c;
--       RAISE EXCEPTION 'FALLA (c): se cambio el canon de un contrato V3 cancelado';
--     EXCEPTION WHEN check_violation THEN NULL;
--     END;
--     -- (d) partes: no se agregan fuera de borrador; estudio_id → NULL pasa; DELETE en cascada
--     BEGIN
--       INSERT INTO contrato_partes (contrato_id, rol, orden, nombre, tipo_documento, numero_documento)
--         VALUES (c, 'coarrendatario', 2, 'Prueba 2', 'cc', '654321');
--       RAISE EXCEPTION 'FALLA (d): se agrego una parte a un contrato cancelado';
--     EXCEPTION WHEN check_violation THEN NULL;
--     END;
--     UPDATE contrato_partes SET estudio_id = NULL WHERE id = p;
--     DELETE FROM contratos WHERE id = c;
--     ASSERT NOT EXISTS (SELECT 1 FROM contrato_partes WHERE id = p), 'FALLA (d): la parte no se borro en cascada';
--     -- (e) legacy (destinacion NULL) cancelado sigue editable
--     INSERT INTO contratos (expediente_id, estado) VALUES (e, 'cancelado') RETURNING id INTO c;
--     UPDATE contratos SET valor_arriendo = 1 WHERE id = c;
--     -- (f) perfiles: 'nit' no, tipo sin numero no, ambos si
--     p := (SELECT id FROM perfiles LIMIT 1);
--     BEGIN
--       UPDATE perfiles SET representante_legal_tipo_documento = 'nit', representante_legal_documento = '900123456' WHERE id = p;
--       RAISE EXCEPTION 'FALLA (f): se acepto tipo nit';
--     EXCEPTION WHEN check_violation THEN NULL;
--     END;
--     BEGIN
--       UPDATE perfiles SET representante_legal_tipo_documento = 'cc', representante_legal_documento = NULL WHERE id = p;
--       RAISE EXCEPTION 'FALLA (f): se acepto tipo sin numero';
--     EXCEPTION WHEN check_violation THEN NULL;
--     END;
--     UPDATE perfiles SET representante_legal_tipo_documento = 'cc', representante_legal_documento = '1020304050' WHERE id = p;
--     RAISE NOTICE 'Verificacion E3: todo OK';
--   END $v$;
--   ROLLBACK;
-- Pre-flight antes del push de la API (debe dar 0):
--   SELECT count(*) FROM contratos WHERE destinacion IS NOT NULL;

-- ROLLBACK (manual, no se ejecuta aqui):
--   DROP TRIGGER IF EXISTS contrato_partes_solo_borrador ON public.contrato_partes;
--   DROP TRIGGER IF EXISTS contratos_v3_congelado ON public.contratos;
--   DROP FUNCTION IF EXISTS public.fn_contrato_partes_solo_borrador();
--   DROP FUNCTION IF EXISTS public.fn_contratos_v3_congelado();
--   DROP INDEX IF EXISTS public.contratos_v3_vivo_uq;
--   ALTER TABLE public.perfiles DROP CONSTRAINT IF EXISTS perfiles_rep_legal_doc_chk,
--     DROP COLUMN IF EXISTS representante_legal_tipo_documento,
--     DROP COLUMN IF EXISTS representante_legal_documento;
