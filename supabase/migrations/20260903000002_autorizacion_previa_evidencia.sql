-- ============================================================
-- Cofianza 2.0 — Autorizacion habeas data: evidencia completa e inalterable
--
-- Fase 0 del analisis de brecha. Cierra dos exigencias literales del
-- documento de Gerencia "Flujo del modulo de estudios", seccion 8.4:
--
--   "El sistema debe almacenar, asociado al estudio y de forma INALTERABLE:
--    fecha y hora exacta de la aceptacion, direccion IP, identificacion del
--    dispositivo y del navegador, el texto integro de la autorizacion tal
--    como fue presentado y aceptado con su version, y EL NUMERO DE DOCUMENTO
--    DE QUIEN ACEPTO."
--
-- Estado previo (medido en produccion el 2026-09-03):
--   - ip_autorizacion, user_agent, texto_autorizado, version_terminos y
--     autorizado_en YA existen y estan poblados en las 8 autorizaciones. No
--     se tocan.
--   - FALTA el numero de documento del aceptante. Hoy solo se deduce por FK
--     a solicitantes.numero_documento, que es editable y que el propio
--     sistema reescribe (sincronizarDocumentoSolicitante). Un dato mutable
--     no sirve como prueba de quien autorizo.
--   - FALTA la inalterabilidad: cero triggers, cero restricciones de UPDATE
--     o DELETE. La API usa service_role, que omite las 3 politicas RLS.
--   - FALTA vigencia. Lo unico con caducidad es el enlace sin firmar
--     (token_expiracion, 48 h); una firma quedaba valida para siempre.
--
-- Esta migracion NO modifica ninguna de las 8 filas existentes ni ningun
-- estudio historico.
-- ============================================================

-- ============================================================
-- 1. COLUMNAS NUEVAS
-- ============================================================

ALTER TABLE autorizaciones_habeas_data
  -- Documento del aceptante CONGELADO en el momento de aceptar. Deliberadamente
  -- NO es una FK ni una vista sobre solicitantes.numero_documento: ese campo es
  -- editable por el gestor y el propio backend lo reescribe tras cada ejecucion
  -- (sincronizarDocumentoSolicitante). La prueba del 8.4 tiene que ser un
  -- snapshot, no una referencia viva.
  --
  -- NULLABLE a proposito: las 8 autorizaciones firmadas antes de esta migracion
  -- no capturaron el dato y NO se rellenan por inferencia — deducirlo hoy desde
  -- solicitantes seria fabricar evidencia sobre un campo que ya pudo cambiar.
  -- Quedan en NULL, declaradas como "evidencia parcial (pre-2026-09-03)". El
  -- gate de la API las acepta con warning; toda autorizacion nueva lo trae.
  ADD COLUMN IF NOT EXISTS numero_documento_aceptante VARCHAR(20),
  ADD COLUMN IF NOT EXISTS tipo_documento_aceptante   tipo_documento_id,

  -- Sujeto alternativo: el co-arrendatario invitado no es una fila de
  -- `solicitantes`, y su consulta al buro exige su PROPIA autorizacion (no la
  -- del titular). Sin esta columna no habia donde registrarla.
  ADD COLUMN IF NOT EXISTS coarrendatario_id UUID,

  -- Vigencia. Se calcula UNA sola vez, al firmar (autorizado_en + vigencia_meses)
  -- y queda congelada: si Gerencia cambia la politica manana, la evidencia
  -- pasada no se reescribe. vigencia_meses guarda la politica que se aplico.
  ADD COLUMN IF NOT EXISTS vigencia_meses SMALLINT,
  ADD COLUMN IF NOT EXISTS vigente_hasta  TIMESTAMPTZ;

COMMENT ON COLUMN autorizaciones_habeas_data.numero_documento_aceptante IS
  'Ley 1266/2008 y Ley 1581/2012, flujo 8.4: numero de documento de quien acepto, congelado al aceptar. NULL solo en las autorizaciones anteriores al 2026-09-03 (evidencia parcial).';
COMMENT ON COLUMN autorizaciones_habeas_data.tipo_documento_aceptante IS
  'Tipo de documento del aceptante, congelado al aceptar. NULL en las autorizaciones anteriores al 2026-09-03.';
COMMENT ON COLUMN autorizaciones_habeas_data.coarrendatario_id IS
  'Sujeto de la autorizacion cuando quien acepta es el co-arrendatario invitado (expediente_coarrendatarios), que no tiene fila en solicitantes. Excluyente con solicitante_id.';
COMMENT ON COLUMN autorizaciones_habeas_data.vigencia_meses IS
  'Politica de vigencia aplicada al firmar, en meses. NULL = sin vigencia declarada (las 8 filas historicas) y se interpreta como vigente.';
COMMENT ON COLUMN autorizaciones_habeas_data.vigente_hasta IS
  'autorizado_en + vigencia_meses, congelado al firmar. NULL = sin vigencia declarada = vigente. El predicado del gate es (vigente_hasta IS NULL OR vigente_hasta > now()).';

-- El sujeto puede ser un solicitante O un co-arrendatario, nunca ambos y nunca
-- ninguno. Para admitir el co-arrendatario hay que soltar el NOT NULL original
-- de solicitante_id; el CHECK de abajo mantiene la garantia real.
ALTER TABLE autorizaciones_habeas_data
  ALTER COLUMN solicitante_id DROP NOT NULL;

-- ============================================================
-- 2. CHECKS NOMBRADOS
--
-- Aparte de la columna y con DROP IF EXISTS previo: `ADD COLUMN IF NOT EXISTS`
-- con CHECK inline no es idempotente (si la columna ya existe, el CHECK no se
-- crea y la migracion miente sobre lo que dejo).
-- ============================================================

-- FK aparte de la columna, por la misma razon que los CHECK: con
-- `ADD COLUMN IF NOT EXISTS ... REFERENCES ...`, si la columna ya existiera la
-- FK no se crearia y la migracion mentiria sobre lo que dejo.
ALTER TABLE autorizaciones_habeas_data
  DROP CONSTRAINT IF EXISTS fk_autorizaciones_coarrendatario;
ALTER TABLE autorizaciones_habeas_data
  ADD CONSTRAINT fk_autorizaciones_coarrendatario
  FOREIGN KEY (coarrendatario_id) REFERENCES expediente_coarrendatarios(id);

ALTER TABLE autorizaciones_habeas_data
  DROP CONSTRAINT IF EXISTS chk_autorizaciones_sujeto_unico;
ALTER TABLE autorizaciones_habeas_data
  ADD CONSTRAINT chk_autorizaciones_sujeto_unico
  CHECK (num_nonnulls(solicitante_id, coarrendatario_id) = 1);

ALTER TABLE autorizaciones_habeas_data
  DROP CONSTRAINT IF EXISTS chk_autorizaciones_documento_aceptante;
ALTER TABLE autorizaciones_habeas_data
  ADD CONSTRAINT chk_autorizaciones_documento_aceptante
  CHECK (
    numero_documento_aceptante IS NULL
    -- Solo "no vacio". A proposito NO se valida el formato aqui.
    --
    -- La validacion de entrada del documento es z.string().min(1).max(20) sin
    -- charset (solicitantes.schema.ts, coarrendatarios.schema.ts), asi que la
    -- base admite hoy documentos con espacios ('AB 123456' de un pasaporte, la
    -- poblacion migrante con PPT/PEP del 5.1) o de menos de 4 caracteres. Un
    -- CHECK mas estricto que la app no protege nada: lo unico que consigue es
    -- que el UPDATE de la firma reviente con un error generico
    -- ('Error al firmar la autorizacion') y que esa persona no pueda autorizar
    -- NUNCA — y como el gate exige la autorizacion, su expediente queda muerto.
    --
    -- La integridad real de esta columna es que sea un SNAPSHOT congelado (lo
    -- garantizan el trigger de inalterabilidad y el hecho de no ser una FK), no
    -- su formato. La comparacion se hace normalizada en la app
    -- (normalizarDocumento en autorizacion.guard.ts).
    OR btrim(numero_documento_aceptante) <> ''
  );

ALTER TABLE autorizaciones_habeas_data
  DROP CONSTRAINT IF EXISTS chk_autorizaciones_vigencia_meses;
ALTER TABLE autorizaciones_habeas_data
  ADD CONSTRAINT chk_autorizaciones_vigencia_meses
  CHECK (vigencia_meses IS NULL OR (vigencia_meses >= 1 AND vigencia_meses <= 120));

-- Una autorizacion firmada tiene que traer su momento de aceptacion: sin
-- autorizado_en no hay forma de probar que fue PREVIA a la consulta.
ALTER TABLE autorizaciones_habeas_data
  DROP CONSTRAINT IF EXISTS chk_autorizaciones_firmada_con_fecha;
ALTER TABLE autorizaciones_habeas_data
  ADD CONSTRAINT chk_autorizaciones_firmada_con_fecha
  CHECK (estado <> 'autorizado' OR autorizado_en IS NOT NULL);

-- ============================================================
-- 3. INDICES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_autorizaciones_documento_aceptante
  ON autorizaciones_habeas_data(numero_documento_aceptante)
  WHERE numero_documento_aceptante IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_autorizaciones_coarrendatario
  ON autorizaciones_habeas_data(coarrendatario_id)
  WHERE coarrendatario_id IS NOT NULL;

-- ============================================================
-- 4. PREDICADO UNICO DE VIGENCIA
--
-- Un solo sitio donde vive la regla, para que el gate de la API, la UI y los
-- reportes no diverjan. La API replica exactamente este predicado en
-- src/modules/estudios/autorizacion.guard.ts (evaluarAutorizacionPrevia).
-- ============================================================

CREATE OR REPLACE FUNCTION fn_autorizacion_es_vigente(
  a autorizaciones_habeas_data,
  momento TIMESTAMPTZ DEFAULT now()
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT a.estado = 'autorizado'
     AND a.fecha_revocacion IS NULL
     AND a.autorizado_en IS NOT NULL
     AND a.autorizado_en <= momento
     AND (a.vigente_hasta IS NULL OR a.vigente_hasta > momento);
$$;

COMMENT ON FUNCTION fn_autorizacion_es_vigente(autorizaciones_habeas_data, TIMESTAMPTZ) IS
  'Predicado canonico de "autorizacion previa vigente" (flujo 8.4). vigente_hasta NULL = sin vigencia declarada = vigente, para no invalidar retroactivamente las 8 autorizaciones historicas.';

-- ============================================================
-- 5. INALTERABILIDAD
--
-- La API corre con service_role, que omite RLS: la unica barrera que de verdad
-- aplica es un trigger. Un REVOKE UPDATE plano no sirve — romperia la firma
-- (pendiente -> autorizado) y la revocacion, que SI deben poder ocurrir.
--
-- Vias permitidas, y ninguna mas:
--   a) pendiente  -> autorizado : la firma. Escribe la evidencia, una sola vez.
--   b) pendiente  -> expirado   : el enlace caduco sin firmarse.
--   c) autorizado -> revocado   : la unica mutacion posible sobre una firma,
--                                 y solo puede tocar las 3 columnas de
--                                 revocacion (derecho del titular, Ley 1581).
--
-- La comparacion se hace con to_jsonb() menos las claves autorizadas, asi
-- cualquier columna que se agregue en el futuro queda protegida por defecto
-- sin tener que acordarse de esta funcion.
-- ============================================================

CREATE OR REPLACE FUNCTION fn_autorizaciones_habeas_data_inalterable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  -- Columnas que la FIRMA puede escribir (todas estaban en NULL/default).
  k_firma  TEXT[] := ARRAY[
    'estado', 'metodo_firma', 'datos_firma', 'hash_documento', 'referencia_otp',
    'autorizado_en', 'ip_autorizacion', 'user_agent',
    'numero_documento_aceptante', 'tipo_documento_aceptante',
    'vigencia_meses', 'vigente_hasta',
    'consent_analitica', 'consent_comercial', 'consent_historial_referencia'
  ];
  -- Columnas que la REVOCACION puede escribir.
  k_revoca TEXT[] := ARRAY['estado', 'fecha_revocacion', 'motivo_revocacion'];
  j_old JSONB;
  j_new JSONB;
  k     TEXT;
BEGIN
  -- (a) Firma
  IF OLD.estado = 'pendiente' AND NEW.estado = 'autorizado' THEN
    j_old := to_jsonb(OLD);
    j_new := to_jsonb(NEW);
    FOREACH k IN ARRAY k_firma LOOP
      j_old := j_old - k;
      j_new := j_new - k;
    END LOOP;
    IF j_old IS DISTINCT FROM j_new THEN
      RAISE EXCEPTION
        'autorizaciones_habeas_data: al firmar solo se puede escribir la evidencia de la firma; el resto de la fila es inalterable (id %)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.autorizado_en IS NULL THEN
      RAISE EXCEPTION
        'autorizaciones_habeas_data: una firma sin autorizado_en no es evidencia de autorizacion previa (id %)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- (b) Caducidad del enlace sin firmar
  IF OLD.estado = 'pendiente' AND NEW.estado = 'expirado' THEN
    IF (to_jsonb(NEW) - 'estado') IS DISTINCT FROM (to_jsonb(OLD) - 'estado') THEN
      RAISE EXCEPTION
        'autorizaciones_habeas_data: al expirar un enlace solo puede cambiar el estado (id %)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- (c) Revocacion — unica mutacion admitida sobre una autorizacion firmada
  IF OLD.estado = 'autorizado' AND NEW.estado = 'revocado' THEN
    j_old := to_jsonb(OLD);
    j_new := to_jsonb(NEW);
    FOREACH k IN ARRAY k_revoca LOOP
      j_old := j_old - k;
      j_new := j_new - k;
    END LOOP;
    IF j_old IS DISTINCT FROM j_new THEN
      RAISE EXCEPTION
        'autorizaciones_habeas_data: revocar solo puede escribir fecha_revocacion y motivo_revocacion (id %)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.fecha_revocacion IS NULL THEN
      RAISE EXCEPTION
        'autorizaciones_habeas_data: una revocacion exige fecha_revocacion (id %)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'autorizaciones_habeas_data es evidencia legal inalterable (Ley 1266/2008, Ley 1581/2012). Transicion % -> % no permitida sobre la fila %. Unicas vias: firmar (pendiente->autorizado), expirar el enlace (pendiente->expirado) y revocar (autorizado->revocado).',
    OLD.estado, NEW.estado, OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS trg_autorizaciones_habeas_data_inalterable ON autorizaciones_habeas_data;
CREATE TRIGGER trg_autorizaciones_habeas_data_inalterable
  BEFORE UPDATE ON autorizaciones_habeas_data
  FOR EACH ROW EXECUTE FUNCTION fn_autorizaciones_habeas_data_inalterable();

CREATE OR REPLACE FUNCTION fn_autorizaciones_habeas_data_no_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Un enlace que nunca se firmo no prueba nada: se puede limpiar (es lo que
  -- necesita el wipe de QA). Una autorizacion firmada, o firmada y revocada,
  -- es la prueba que exige el 8.4 y no se borra por ninguna via.
  IF OLD.autorizado_en IS NOT NULL OR OLD.estado IN ('autorizado', 'revocado') THEN
    RAISE EXCEPTION
      'autorizaciones_habeas_data: no se puede borrar la evidencia de una autorizacion firmada (id %, estado %). Es la prueba exigida por la Ley 1266/2008 y la Ley 1581/2012.',
      OLD.id, OLD.estado
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_autorizaciones_habeas_data_no_delete ON autorizaciones_habeas_data;
CREATE TRIGGER trg_autorizaciones_habeas_data_no_delete
  BEFORE DELETE ON autorizaciones_habeas_data
  FOR EACH ROW EXECUTE FUNCTION fn_autorizaciones_habeas_data_no_delete();

-- TRUNCATE NO dispara un trigger BEFORE DELETE ... FOR EACH ROW, y tampoco esta
-- sujeto a RLS. Sin lo que sigue, un solo TRUNCATE (desde el SQL Editor de
-- Studio, desde psql con la service key, o desde una futura version de
-- fn_wipe_test_data que "optimice" el borrado) vaciaba la tabla entera sin que
-- la proteccion de arriba se ejecutara ni una vez: toda la evidencia del 8.4
-- desaparecia sin dejar error.
CREATE OR REPLACE FUNCTION fn_autorizaciones_habeas_data_no_truncate()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_firmadas bigint;
BEGIN
  SELECT count(*) INTO v_firmadas
    FROM autorizaciones_habeas_data
   WHERE autorizado_en IS NOT NULL OR estado IN ('autorizado', 'revocado');

  IF v_firmadas > 0 THEN
    RAISE EXCEPTION
      'autorizaciones_habeas_data: TRUNCATE bloqueado, la tabla contiene % autorizacion(es) firmada(s). Es la prueba exigida por la Ley 1266/2008 y la Ley 1581/2012.', v_firmadas
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_autorizaciones_habeas_data_no_truncate ON autorizaciones_habeas_data;
CREATE TRIGGER trg_autorizaciones_habeas_data_no_truncate
  BEFORE TRUNCATE ON autorizaciones_habeas_data
  FOR EACH STATEMENT EXECUTE FUNCTION fn_autorizaciones_habeas_data_no_truncate();

-- Los roles del navegador no tienen ninguna razon para borrar evidencia legal.
-- El grant por defecto de Supabase les da DELETE y TRUNCATE sobre las tablas
-- nuevas; aqui se retira. La API (service_role) conserva DELETE porque el wipe
-- de QA sigue necesitando limpiar los enlaces NUNCA firmados, y el trigger de
-- arriba es quien decide cuales.
REVOKE TRUNCATE, DELETE ON autorizaciones_habeas_data FROM anon, authenticated;
REVOKE TRUNCATE, DELETE ON autorizacion_otps          FROM anon, authenticated;
REVOKE TRUNCATE ON autorizaciones_habeas_data FROM service_role;
REVOKE TRUNCATE ON autorizacion_otps          FROM service_role;

-- ============================================================
-- 6. WIPE DE QA — dejar de destruir la evidencia
--
-- `fn_wipe_test_data` (POST /api/v1/admin-tools/wipe-test-data, vivo en
-- produccion) borraba autorizaciones_habeas_data, autorizacion_otps y la
-- bitacora completa — incluido el rastro de su propia ejecucion. Con los
-- triggers de arriba abortaria a mitad de transaccion con un error opaco.
--
-- Se redefine identica a 20260610000004 salvo en cinco puntos:
--   1. Solo borra autorizaciones NUNCA firmadas.
--   2. Solo borra OTPs que no cuelgan de una autorizacion firmada (los OTPs de
--      una firma son la prueba de posesion del celular: Ley 527/1999).
--   3. Conserva los expedientes, co-arrendatarios, solicitantes e inmuebles
--      referenciados por una autorizacion firmada (si no, el FK aborta el wipe).
--   4. Conserva las entradas de bitacora de entidad 'autorizacion'.
--   5. Conserva los estudios que cuelgan de una autorizacion firmada: sin ellos
--      la evidencia queda huerfana (el 8.4 la pide "asociada al estudio").
--   6. Devuelve `evidencia_preservada` y `estudios_preservados` para que el
--      operador vea que quedo vivo.
-- ============================================================

CREATE OR REPLACE FUNCTION fn_wipe_test_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_counts jsonb := '{}'::jsonb;
  v_count bigint;
BEGIN
  -- Facturas PRIMERO: referencian pagos y compras de créditos (FK no deferible).
  DELETE FROM facturas WHERE true;                    GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{facturas}', to_jsonb(v_count));

  -- Firma / contratos
  DELETE FROM evidencias_firma WHERE true;            GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{evidencias_firma}', to_jsonb(v_count));
  DELETE FROM codigos_otp WHERE true;                 GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{codigos_otp}', to_jsonb(v_count));
  DELETE FROM solicitudes_firma WHERE true;           GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{solicitudes_firma}', to_jsonb(v_count));
  DELETE FROM contrato_versiones WHERE true;          GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{contrato_versiones}', to_jsonb(v_count));
  DELETE FROM contrato_archivos WHERE true;           GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{contrato_archivos}', to_jsonb(v_count));
  DELETE FROM contrato_historial_estados WHERE true;  GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{contrato_historial_estados}', to_jsonb(v_count));
  DELETE FROM contrato_accesos_firmado WHERE true;    GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{contrato_accesos_firmado}', to_jsonb(v_count));
  DELETE FROM contratos WHERE true;                   GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{contratos}', to_jsonb(v_count));

  -- Estudios
  DELETE FROM estudios_documentos_soporte WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{estudios_documentos_soporte}', to_jsonb(v_count));
  DELETE FROM estudios_certificados WHERE true;       GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{estudios_certificados}', to_jsonb(v_count));

  -- Co-arrendatarios: se conservan los que son sujeto de una autorizacion firmada.
  DELETE FROM expediente_coarrendatarios c
   WHERE NOT EXISTS (
     SELECT 1 FROM autorizaciones_habeas_data a
      WHERE a.coarrendatario_id = c.id AND a.autorizado_en IS NOT NULL
   );                                                 GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{expediente_coarrendatarios}', to_jsonb(v_count));

  -- Estudios: se conservan los que cuelgan de una autorizacion firmada. El 8.4
  -- exige la evidencia "ASOCIADO AL ESTUDIO": borrar el estudio deja la firma
  -- huerfana — se puede probar que alguien autorizo, pero ya no a que consulta
  -- correspondio, que es justo lo que hay que poder demostrar.
  DELETE FROM estudios e
   WHERE NOT EXISTS (
     SELECT 1 FROM autorizaciones_habeas_data a
      WHERE a.id = e.autorizacion_habeas_data_id AND a.autorizado_en IS NOT NULL
   );                                                 GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{estudios}', to_jsonb(v_count));

  -- Autorizaciones habeas data: SOLO las que nunca llegaron a firmarse.
  DELETE FROM autorizaciones_habeas_data
   WHERE autorizado_en IS NULL
     AND estado NOT IN ('autorizado', 'revocado');    GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{autorizaciones_habeas_data}', to_jsonb(v_count));

  -- OTPs: los de una autorizacion firmada son prueba de posesion (Ley 527/1999).
  DELETE FROM autorizacion_otps o
   WHERE NOT EXISTS (
     SELECT 1 FROM autorizaciones_habeas_data a
      WHERE a.id = o.autorizacion_id AND a.autorizado_en IS NOT NULL
   );                                                 GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{autorizacion_otps}', to_jsonb(v_count));

  -- Créditos de estudios (lotes/compras; el catálogo de paquetes se conserva)
  DELETE FROM movimientos_creditos_estudios WHERE true; GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{movimientos_creditos_estudios}', to_jsonb(v_count));
  DELETE FROM lotes_creditos_estudios WHERE true;       GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{lotes_creditos_estudios}', to_jsonb(v_count));
  DELETE FROM compras_creditos_estudios WHERE true;     GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{compras_creditos_estudios}', to_jsonb(v_count));

  -- Pagos
  DELETE FROM eventos_pago WHERE true;                GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{eventos_pago}', to_jsonb(v_count));
  DELETE FROM pagos WHERE true;                       GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{pagos}', to_jsonb(v_count));
  DELETE FROM pagos_no_conciliados WHERE true;        GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{pagos_no_conciliados}', to_jsonb(v_count));

  -- Documentos / actividad del expediente
  DELETE FROM documentos WHERE true;                  GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{documentos}', to_jsonb(v_count));
  DELETE FROM comentarios WHERE true;                 GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{comentarios}', to_jsonb(v_count));
  DELETE FROM eventos_timeline WHERE true;            GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{eventos_timeline}', to_jsonb(v_count));
  DELETE FROM notificaciones WHERE true;              GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{notificaciones}', to_jsonb(v_count));
  DELETE FROM citas WHERE true;                       GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{citas}', to_jsonb(v_count));

  -- Moras y soporte
  DELETE FROM moras_mensajes WHERE true;              GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{moras_mensajes}', to_jsonb(v_count));
  DELETE FROM moras_tickets WHERE true;               GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{moras_tickets}', to_jsonb(v_count));
  DELETE FROM tickets_soporte WHERE true;             GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{tickets_soporte}', to_jsonb(v_count));

  -- Expedientes / solicitantes / inmuebles. Se conservan los referenciados por
  -- una autorizacion firmada: borrarlos violaria el FK y abortaria el wipe.
  DELETE FROM expedientes e
   WHERE NOT EXISTS (
     SELECT 1 FROM autorizaciones_habeas_data a
      WHERE a.expediente_id = e.id AND a.autorizado_en IS NOT NULL
   );                                                 GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{expedientes}', to_jsonb(v_count));
  DELETE FROM expediente_yearly_seq WHERE true;       GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{expediente_yearly_seq}', to_jsonb(v_count));
  DELETE FROM solicitantes s
   WHERE NOT EXISTS (
     SELECT 1 FROM autorizaciones_habeas_data a
      WHERE a.solicitante_id = s.id AND a.autorizado_en IS NOT NULL
   )
     AND NOT EXISTS (SELECT 1 FROM expedientes e WHERE e.solicitante_id = s.id);
                                                      GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{solicitantes}', to_jsonb(v_count));
  DELETE FROM vitrina_interacciones WHERE true;       GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{vitrina_interacciones}', to_jsonb(v_count));
  DELETE FROM cambios_inmuebles WHERE true;           GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{cambios_inmuebles}', to_jsonb(v_count));
  DELETE FROM fotos_inmueble WHERE true;              GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{fotos_inmueble}', to_jsonb(v_count));
  DELETE FROM inmuebles i
   WHERE NOT EXISTS (SELECT 1 FROM expedientes e WHERE e.inmueble_id = i.id);
                                                      GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{inmuebles}', to_jsonb(v_count));

  -- Tabla legacy `firmas` (si ya fue dropeada, seguimos sin error).
  BEGIN
    EXECUTE 'DELETE FROM firmas WHERE true';
  EXCEPTION WHEN undefined_table THEN
    NULL;
  END;

  -- Bitácora: se conserva el rastro de las autorizaciones (enlace enviado,
  -- firma, revocacion). Es la auditoria que respalda la evidencia del 8.4.
  DELETE FROM bitacora WHERE entidad IS DISTINCT FROM 'autorizacion';
                                                      GET DIAGNOSTICS v_count = ROW_COUNT; v_counts := jsonb_set(v_counts, '{bitacora}', to_jsonb(v_count));

  -- NO se borra ninguna cuenta (perfiles / auth.users) ni los datos ligados a
  -- la cuenta: disponibilidad_propietario, email_verification_tokens,
  -- password_reset_tokens, terminos_aceptaciones, documentos_legales_inmobiliaria.
  v_counts := jsonb_set(v_counts, '{cuentas_preservadas}', to_jsonb((SELECT count(*) FROM perfiles)));
  v_counts := jsonb_set(
    v_counts, '{evidencia_preservada}',
    to_jsonb((SELECT count(*) FROM autorizaciones_habeas_data WHERE autorizado_en IS NOT NULL))
  );
  v_counts := jsonb_set(
    v_counts, '{estudios_preservados}',
    to_jsonb((SELECT count(*) FROM estudios))
  );

  RETURN v_counts;
END;
$$;

COMMENT ON FUNCTION fn_wipe_test_data() IS
  'Wipe de QA. Desde 2026-09-03 NO borra autorizaciones habeas data firmadas, sus OTPs, la bitacora de autorizaciones, los estudios que esa evidencia habilito, ni los expedientes/solicitantes/inmuebles/co-arrendatarios que referencia.';
