-- ============================================================
-- Migración de cartera, Fase 1 (migracion/especificacion.txt;
-- plan migracion/plan-fase1-detalle.md, decisiones A1-A8).
--
-- 1. contratos.origen / expedientes.origen: la cartera migrada vive en las
--    tablas de siempre, marcada (A1, A2). Analítica separa por origen (§9.5).
-- 2. inmobiliarias: suspensión de nuevas migraciones por declaración falsa (§7.2.2).
-- 3. Tablas nuevas: migracion_habilitaciones (§1.1.4-1.1.5), migracion_lotes,
--    migracion_filas (el «BORRADOR» de la spec, A3), migracion_actas (proceso
--    Auco del acta, A7) y migracion_auditorias (§7.3).
-- 4. fn_activar_lote_migracion: activa TODO el lote en una transacción al
--    firmarse el acta (§4.1, A3, A6).
--
-- Solo SUMA columnas, tablas y funciones; no escribe datos existentes.
-- Idempotente (IF NOT EXISTS / CREATE OR REPLACE). Tablas nuevas con RLS
-- habilitada SIN políticas: solo la API (service_role) las lee y escribe.
-- Correr ANTES de 20261007000002 (que lee contratos.origen y expedientes.origen).
--
-- Verificación (solo lectura, después de correrla):
--   SELECT relname, relrowsecurity FROM pg_class
--    WHERE relname LIKE 'migracion\_%' AND relkind = 'r';                      -- 5 filas, todas true
--   SELECT count(*) FROM pg_policies WHERE tablename LIKE 'migracion\_%';      -- 0
--   SELECT origen, count(*) FROM contratos GROUP BY 1;                         -- todo 'plataforma'
--   SELECT origen, count(*) FROM expedientes GROUP BY 1;                       -- todo 'estudio'
--   SELECT has_function_privilege('anon', 'public.fn_activar_lote_migracion(uuid, timestamptz)', 'EXECUTE'),
--          has_function_privilege('authenticated', 'public.fn_activar_lote_migracion(uuid, timestamptz)', 'EXECUTE'),
--          has_function_privilege('service_role', 'public.fn_activar_lote_migracion(uuid, timestamptz)', 'EXECUTE');
--   -- esperado: false, false, true
--
-- ROLLBACK (manual, solo si no hay lotes activados):
--   DROP FUNCTION IF EXISTS public.fn_activar_lote_migracion(uuid, timestamptz);
--   DROP TABLE IF EXISTS public.migracion_auditorias, public.migracion_actas,
--     public.migracion_filas, public.migracion_lotes, public.migracion_habilitaciones;
--   DROP FUNCTION IF EXISTS public.fn_migracion_lotes_numero();
--   ALTER TABLE public.inmobiliarias DROP COLUMN IF EXISTS migracion_suspendida_en,
--     DROP COLUMN IF EXISTS migracion_suspendida_motivo, DROP COLUMN IF EXISTS migracion_reactivada_por;
--   DROP INDEX IF EXISTS public.idx_contratos_origen_estado;
--   ALTER TABLE public.contratos DROP COLUMN IF EXISTS origen;
--   ALTER TABLE public.expedientes DROP COLUMN IF EXISTS origen;
-- ============================================================

BEGIN;

-- ── 1. Origen de contratos y expedientes ──

ALTER TABLE public.contratos
  ADD COLUMN IF NOT EXISTS origen TEXT NOT NULL DEFAULT 'plataforma';
ALTER TABLE public.contratos DROP CONSTRAINT IF EXISTS contratos_origen_chk;
ALTER TABLE public.contratos ADD CONSTRAINT contratos_origen_chk CHECK (
  origen IN ('plataforma', 'migracion')
  -- A1: un contrato migrado es siempre V3 (hereda numero CTO, congelado y matriz V3).
  AND (origen = 'plataforma' OR destinacion IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_contratos_origen_estado ON public.contratos (origen, estado);

COMMENT ON COLUMN public.contratos.origen IS
  'plataforma = originado por estudio + contrato en Cofianza; migracion = contrato preexistente vinculado por migración de cartera (sin estudio, sin prima, modalidad Tradicional). Toda analítica separa por esta columna (spec migración §9.5).';

ALTER TABLE public.expedientes
  ADD COLUMN IF NOT EXISTS origen TEXT NOT NULL DEFAULT 'estudio';
ALTER TABLE public.expedientes DROP CONSTRAINT IF EXISTS expedientes_origen_chk;
ALTER TABLE public.expedientes ADD CONSTRAINT expedientes_origen_chk CHECK (origen IN ('estudio', 'migracion'));

COMMENT ON COLUMN public.expedientes.origen IS
  'estudio = flujo normal; migracion = expediente mínimo (nace cerrado) que solo soporta un contrato migrado. No aparece en las listas de estudios.';

-- ── 2. Suspensión de migraciones por inmobiliaria (§7.2.2) ──

ALTER TABLE public.inmobiliarias
  ADD COLUMN IF NOT EXISTS migracion_suspendida_en     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS migracion_suspendida_motivo TEXT,
  ADD COLUMN IF NOT EXISTS migracion_reactivada_por    UUID REFERENCES public.perfiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.inmobiliarias.migracion_suspendida_en IS
  'Spec migración §7.2.2: al primer contrato con declaración falsa verificada se bloquean nuevas cargas. NULL = puede cargar. Solo la Gerencia General la levanta.';
COMMENT ON COLUMN public.inmobiliarias.migracion_reactivada_por IS
  'Quién levantó la última suspensión (Gerencia General).';

-- ── 3a. Habilitación por inmobiliaria y destinación (§1.1.4-1.1.5) ──

CREATE TABLE IF NOT EXISTS public.migracion_habilitaciones (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inmobiliaria_id               UUID NOT NULL REFERENCES public.inmobiliarias(id) ON DELETE CASCADE,
  destinacion                   TEXT NOT NULL CHECK (destinacion IN ('vivienda', 'comercial')),
  estado                        TEXT NOT NULL CHECK (estado IN ('habilitada', 'con_observaciones', 'no_habilitada')),
  -- Checklist §1.1.4 de la plantilla de contrato de la inmobiliaria.
  arrendador_es_inmobiliaria    BOOLEAN,
  habeas_subrogatario           BOOLEAN,
  orden_imputacion              TEXT,
  regimen_prorroga              TEXT,
  deposito_dinero               BOOLEAN,
  renovacion_comercial          TEXT,
  observaciones                 TEXT,
  plantilla_storage_key         TEXT,
  convenio_migracion_storage_key TEXT,
  convenio_vigente_confirmado   BOOLEAN NOT NULL DEFAULT FALSE,
  revisado_por                  UUID REFERENCES public.perfiles(id) ON DELETE SET NULL,
  revisado_en                   TIMESTAMPTZ,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT migracion_habilitaciones_org_destinacion_uq UNIQUE (inmobiliaria_id, destinacion)
);

COMMENT ON TABLE public.migracion_habilitaciones IS
  'Spec migración §1.1.4-1.1.5: revisión manual de la plantilla de contrato de la inmobiliaria, una por destinación. Sin habilitación no se carga archivo.';
COMMENT ON COLUMN public.migracion_habilitaciones.habeas_subrogatario IS
  'La cláusula de habeas data autoriza reportar a quien sea acreedor o subrogatario. Base de la marca REPORTABLE (§5.1.1).';
COMMENT ON COLUMN public.migracion_habilitaciones.renovacion_comercial IS
  'Solo comercial: régimen de renovación y desahucio (C. de Co. arts. 518-523).';

-- ── 3b. Lotes ──

CREATE TABLE IF NOT EXISTS public.migracion_lotes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inmobiliaria_id       UUID NOT NULL REFERENCES public.inmobiliarias(id),
  numero                VARCHAR(20) NOT NULL,  -- lo asigna fn_migracion_lotes_numero
  -- procesado: filas creadas, acta sin enviar · en_firma: acta en Auco ·
  -- activo: acta firmada, contratos creados · expirado: venció sin firma (§3.6) ·
  -- cancelado: lo anuló un analista.
  estado                TEXT NOT NULL DEFAULT 'procesado'
                          CHECK (estado IN ('procesado', 'en_firma', 'activo', 'expirado', 'cancelado')),
  vence_en              TIMESTAMPTZ NOT NULL,
  archivo_storage_key   TEXT,
  archivo_hash          VARCHAR(64),
  -- Acta de Migración sin firmar (§3.1) y su SHA-256: lo que se envía a Auco.
  acta_storage_key      TEXT,
  acta_hash             VARCHAR(64),
  total_aceptadas       INTEGER NOT NULL DEFAULT 0,
  total_rechazadas      INTEGER NOT NULL DEFAULT 0,
  total_advertencias    INTEGER NOT NULL DEFAULT 0,
  exposicion_cop        NUMERIC(16,2) NOT NULL DEFAULT 0,
  alerta_exposicion_en  TIMESTAMPTZ,
  rep_legal_nombre      VARCHAR(200),
  rep_legal_documento   VARCHAR(30),
  rep_legal_email       VARCHAR(255),
  rep_legal_celular     VARCHAR(20),
  activado_en           TIMESTAMPTZ,
  creado_por            UUID REFERENCES public.perfiles(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT migracion_lotes_numero_chk CHECK (numero ~ '^MIG-[0-9]{4}-[0-9]{3,}$'),
  CONSTRAINT migracion_lotes_activo_chk CHECK ((estado = 'activo') = (activado_en IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS migracion_lotes_numero_uq ON public.migracion_lotes (numero);
CREATE INDEX IF NOT EXISTS idx_migracion_lotes_org ON public.migracion_lotes (inmobiliaria_id, created_at DESC);
-- El barrido busca lotes vivos por vencer.
CREATE INDEX IF NOT EXISTS idx_migracion_lotes_vivos ON public.migracion_lotes (vence_en)
  WHERE estado IN ('procesado', 'en_firma');

COMMENT ON TABLE public.migracion_lotes IS
  'Spec migración §2.4 y §8: una carga procesada (segunda pasada). exposicion_cop = suma de 18 cánones por contrato aceptado (§8, vista Cofianza).';
COMMENT ON COLUMN public.migracion_lotes.activado_en IS
  'Última firma del acta según Auco = FECHA DE ACTIVACIÓN de todos los contratos del lote (§3.4, §4.1).';

-- Consecutivo MIG-AAAA-NNN (año de Bogotá), asignado al insertar e inmutable.
-- Mismo patrón que fn_contratos_numero (20260922000001).
CREATE OR REPLACE FUNCTION public.fn_migracion_lotes_numero() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_anio TEXT := to_char(now() AT TIME ZONE 'America/Bogota', 'YYYY');
  v_n    INT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.numero IS DISTINCT FROM OLD.numero THEN
      RAISE EXCEPTION 'migracion_lotes.numero es inmutable' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('migracion_lotes.numero'));
  SELECT COALESCE(MAX(split_part(numero, '-', 3)::INT), 0) + 1 INTO v_n
    FROM public.migracion_lotes WHERE numero LIKE 'MIG-' || v_anio || '-%';
  NEW.numero := 'MIG-' || v_anio || '-' || LPAD(v_n::TEXT, GREATEST(3, length(v_n::TEXT)), '0');
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.fn_migracion_lotes_numero() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS migracion_lotes_numero ON public.migracion_lotes;
CREATE TRIGGER migracion_lotes_numero BEFORE INSERT OR UPDATE OF numero ON public.migracion_lotes
  FOR EACH ROW EXECUTE FUNCTION public.fn_migracion_lotes_numero();

-- ── 3c. Filas (una por fila del archivo procesado) ──

CREATE TABLE IF NOT EXISTS public.migracion_filas (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lote_id                     UUID NOT NULL REFERENCES public.migracion_lotes(id) ON DELETE CASCADE,
  inmobiliaria_id             UUID NOT NULL REFERENCES public.inmobiliarias(id),
  n_fila                      INTEGER NOT NULL CHECK (n_fila >= 1),
  datos                       JSONB NOT NULL CHECK (jsonb_typeof(datos) = 'object'),
  resultado                   TEXT NOT NULL CHECK (resultado IN ('aceptada', 'advertencia', 'rechazada')),
  motivos                     TEXT[] NOT NULL DEFAULT '{}',
  advertencias                TEXT[] NOT NULL DEFAULT '{}',
  clave_inmueble              TEXT,
  documento_arrendatario      VARCHAR(30),
  reportable                  BOOLEAN,
  reportable_motivo           TEXT,
  tarifa_acta_pct             NUMERIC(5,2),
  tarifa_pct                  NUMERIC(5,2),
  tarifa_desde                DATE,
  verificacion_individual_por UUID REFERENCES public.perfiles(id) ON DELETE SET NULL,
  verificacion_individual_en  TIMESTAMPTZ,
  contrato_id                 UUID REFERENCES public.contratos(id) ON DELETE SET NULL,
  en_revision                 BOOLEAN NOT NULL DEFAULT FALSE,
  en_revision_motivo          TEXT,
  excluido_en                 TIMESTAMPTZ,
  excluido_motivo             TEXT CHECK (excluido_motivo IN ('declaracion_falsa', 'auditoria_no_entregada')),
  -- La fila deja de bloquear su inmueble: lote expirado/cancelado o contrato terminado.
  liberada_en                 TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT migracion_filas_lote_fila_uq UNIQUE (lote_id, n_fila),
  CONSTRAINT migracion_filas_excluido_chk CHECK ((excluido_en IS NULL) = (excluido_motivo IS NULL)),
  CONSTRAINT migracion_filas_aceptada_chk CHECK (
    resultado = 'rechazada'
    OR (clave_inmueble IS NOT NULL AND reportable IS NOT NULL AND tarifa_acta_pct IS NOT NULL AND tarifa_pct IS NOT NULL))
);

-- Un inmueble no se migra dos veces en la misma inmobiliaria mientras su fila siga viva.
CREATE UNIQUE INDEX IF NOT EXISTS migracion_filas_inmueble_vivo_uq
  ON public.migracion_filas (inmobiliaria_id, clave_inmueble)
  WHERE resultado IN ('aceptada', 'advertencia') AND excluido_en IS NULL AND liberada_en IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS migracion_filas_contrato_uq
  ON public.migracion_filas (contrato_id) WHERE contrato_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_migracion_filas_documento
  ON public.migracion_filas (inmobiliaria_id, documento_arrendatario);

COMMENT ON TABLE public.migracion_filas IS
  'Spec migración §2.4-§6. El estado de la spec es DERIVADO (A4): rechazada = RECHAZADO EN VALIDACIÓN; aceptada/advertencia sin contrato = BORRADOR; contrato vigente = FIANZA ACTIVA POR MIGRACIÓN (EN REVISIÓN si en_revision); contrato cancelado + excluido_en = EXCLUIDO POR DECLARACIÓN FALSA; contrato finalizado = TERMINADO.';
COMMENT ON COLUMN public.migracion_filas.datos IS
  'Fila normalizada y congelada al procesar. Claves que lee fn_activar_lote_migracion: direccion, municipio, departamento, codigo_interno?, inmueble_id? (inmueble existente de la org), destinacion (vivienda|comercial), tipo_inmueble (enum tipo_inmueble), estrato, canon, iva_canon_pct?, cuota_administracion?, fecha_inicio, fecha_vencimiento (AAAA-MM-DD), arrendatario {tipo_persona, nombre, apellido, razon_social?, tipo_documento, numero_documento, celular, email}. El resto (coarrendatarios, pagos, declaraciones, observaciones) solo se conserva.';
COMMENT ON COLUMN public.migracion_filas.tarifa_acta_pct IS
  'Tarifa mensual impresa en el acta (congelada, A8). La vigente es tarifa_pct desde tarifa_desde (§5.2.5).';
COMMENT ON COLUMN public.migracion_filas.liberada_en IS
  'Cuándo la fila dejó de ocupar su inmueble en migracion_filas_inmueble_vivo_uq (lote expirado o cancelado, contrato terminado).';

-- ── 3d. Actas (proceso de firma Auco, misma forma que contrato_v3_sobres) ──

CREATE TABLE IF NOT EXISTS public.migracion_actas (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lote_id             UUID NOT NULL REFERENCES public.migracion_lotes(id) ON DELETE CASCADE,
  intento             SMALLINT NOT NULL CHECK (intento >= 1),
  -- creando: subiendo a Auco · en_firma: vivo · completo: firmaron todos ·
  -- incompleto: venció o lo rechazaron · cancelado: lo anuló Cofianza · fallido: Auco no lo creó.
  estado              VARCHAR(12) NOT NULL DEFAULT 'creando'
                        CHECK (estado IN ('creando', 'en_firma', 'completo', 'incompleto', 'cancelado', 'fallido')),
  auco_code           VARCHAR(32) UNIQUE,
  expira_en           TIMESTAMPTZ NOT NULL,
  -- [{rol: representante_legal|cofianza, estado, aucoId, firmadoEn}] en orden de firma.
  firmantes           JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(firmantes) = 'array'),
  storage_key         TEXT,
  storage_key_firmado TEXT,
  motivo              VARCHAR(20),
  motivo_detalle      TEXT,
  cerrado_en          TIMESTAMPTZ,
  auco_cancelado_en   TIMESTAMPTZ,
  enviado_por         UUID REFERENCES public.perfiles(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT migracion_actas_intento_uq UNIQUE (lote_id, intento)
);

-- Un acta viva por lote: también es el mutex del envío (dos clics = 23505).
CREATE UNIQUE INDEX IF NOT EXISTS migracion_actas_viva_uq
  ON public.migracion_actas (lote_id) WHERE estado IN ('creando', 'en_firma');
CREATE INDEX IF NOT EXISTS idx_migracion_actas_estado ON public.migracion_actas (estado);

COMMENT ON TABLE public.migracion_actas IS
  'Spec migración §3: Acta de Migración firmada por Auco (representante legal de la inmobiliaria y luego Cofianza). cerrado_en (completo) = fecha de activación del lote.';

-- ── 3e. Auditorías (§7.3) ──

CREATE TABLE IF NOT EXISTS public.migracion_auditorias (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fila_id       UUID NOT NULL REFERENCES public.migracion_filas(id) ON DELETE CASCADE,
  requerido_por UUID REFERENCES public.perfiles(id) ON DELETE SET NULL,
  requerido_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
  vence_en      TIMESTAMPTZ NOT NULL,
  respuesta_en  TIMESTAMPTZ,
  soportes      JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(soportes) = 'array'),
  resultado     TEXT CHECK (resultado IN ('conforme', 'declaracion_falsa', 'no_entregado')),
  notas         TEXT,
  decidido_por  UUID REFERENCES public.perfiles(id) ON DELETE SET NULL,
  decidido_en   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT migracion_auditorias_decision_chk CHECK ((resultado IS NULL) = (decidido_en IS NULL))
);

-- Una auditoría abierta por contrato.
CREATE UNIQUE INDEX IF NOT EXISTS migracion_auditorias_abierta_uq
  ON public.migracion_auditorias (fila_id) WHERE resultado IS NULL;

COMMENT ON TABLE public.migracion_auditorias IS
  'Spec migración §7.3: requerimiento de soportes de recaudo de los 6 meses previos. vence_en = DIAS_RESPUESTA_AUDITORIA días hábiles; no entregar habilita la exclusión.';

-- ── updated_at + RLS sin políticas en las tablas nuevas ──

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['migracion_habilitaciones', 'migracion_lotes', 'migracion_filas',
                           'migracion_actas', 'migracion_auditorias'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_updated_at', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION update_updated_at()',
                   t || '_updated_at', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;

-- ── 4. Activación atómica del lote (§3.4, §4.1, A3, A6) ──
-- La llama la API al quedar el acta 'completo' (con storage_key_firmado ya
-- guardado), con p_activado_en = última firma según Auco. Idempotente: un lote
-- ya activo devuelve sus contratos sin crear nada. Un conflicto que apareció
-- entre el procesamiento y la firma (inmueble ocupado, reservado o con otro
-- contrato vivo) NO aborta: el contrato se crea (el acta lo cubre, §6 «EN
-- REVISIÓN» no suspende la cobertura) y la fila queda en_revision.
CREATE OR REPLACE FUNCTION public.fn_activar_lote_migracion(p_lote uuid, p_activado_en timestamptz)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_lote       migracion_lotes%ROWTYPE;
  v_owner      UUID;
  v_acta       migracion_actas%ROWTYPE;
  f            migracion_filas%ROWTYPE;
  v_d          JSONB;
  v_a          JSONB;
  v_dest       TEXT;
  v_ini        DATE;
  v_fin        DATE;
  v_meses      INT;
  v_codigo     TEXT;
  v_sol        UUID;
  v_inm        UUID;
  v_exp        UUID;
  v_ctr        UUID;
  v_conflicto  TEXT;
  v_hoy        DATE := (p_activado_en AT TIME ZONE 'America/Bogota')::date;
  v_res        JSONB := '[]'::jsonb;
  v_revision   INT := 0;
BEGIN
  IF p_activado_en IS NULL THEN
    RAISE EXCEPTION 'MIGRACION_SIN_FECHA_ACTIVACION';
  END IF;

  -- CAS en_firma -> activo: dos reconciliaciones simultáneas, solo una activa.
  UPDATE migracion_lotes SET estado = 'activo', activado_en = p_activado_en
   WHERE id = p_lote AND estado = 'en_firma'
  RETURNING * INTO v_lote;

  IF NOT FOUND THEN
    SELECT * INTO v_lote FROM migracion_lotes WHERE id = p_lote;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'MIGRACION_LOTE_NO_ENCONTRADO: %', p_lote;
    END IF;
    IF v_lote.estado = 'activo' THEN
      RETURN json_build_object(
        'lote_id', p_lote, 'ya_activo', TRUE, 'activado_en', v_lote.activado_en,
        'contratos', COALESCE((SELECT json_agg(json_build_object(
                       'fila_id', mf.id, 'contrato_id', mf.contrato_id, 'en_revision', mf.en_revision) ORDER BY mf.n_fila)
                     FROM migracion_filas mf WHERE mf.lote_id = p_lote AND mf.contrato_id IS NOT NULL), '[]'::json));
    END IF;
    RAISE EXCEPTION 'MIGRACION_LOTE_NO_EN_FIRMA: el lote % está en estado %', v_lote.numero, v_lote.estado;
  END IF;

  SELECT * INTO v_acta FROM migracion_actas
   WHERE lote_id = p_lote AND estado = 'completo'
   ORDER BY intento DESC LIMIT 1;
  IF NOT FOUND OR v_acta.storage_key_firmado IS NULL THEN
    RAISE EXCEPTION 'MIGRACION_ACTA_SIN_FIRMAR: el lote % no tiene acta firmada guardada', v_lote.numero;
  END IF;

  -- Titular canónico de la inmobiliaria: propietario de los inmuebles que se creen.
  SELECT owner_perfil_id INTO v_owner FROM inmobiliarias WHERE id = v_lote.inmobiliaria_id;

  FOR f IN
    SELECT * FROM migracion_filas
     WHERE lote_id = p_lote AND resultado IN ('aceptada', 'advertencia')
       AND contrato_id IS NULL AND excluido_en IS NULL
     ORDER BY n_fila
     FOR UPDATE
  LOOP
    v_d    := f.datos;
    v_a    := v_d->'arrendatario';
    v_dest := v_d->>'destinacion';
    v_ini  := (v_d->>'fecha_inicio')::date;
    v_fin  := (v_d->>'fecha_vencimiento')::date;
    -- Meses del contrato, redondeando hacia arriba la fracción (31-ene a 30-ene = 12).
    v_meses := GREATEST(1, (date_part('year', age(v_fin, v_ini)) * 12 + date_part('month', age(v_fin, v_ini))
               + CASE WHEN date_part('day', age(v_fin, v_ini)) > 0 THEN 1 ELSE 0 END)::int);
    v_conflicto := NULL;

    -- Solicitante: el de la org con ese documento (idx_solicitantes_documento_por_agencia) o uno nuevo.
    -- ponytail: un INSERT concurrente del mismo documento aborta la activación (23505); la reconciliación reintenta.
    SELECT id INTO v_sol FROM solicitantes
     WHERE COALESCE(inmobiliaria_id, creado_por) = v_lote.inmobiliaria_id
       AND tipo_documento = (v_a->>'tipo_documento')::tipo_documento_id
       AND numero_documento = v_a->>'numero_documento';
    IF NOT FOUND THEN
      INSERT INTO solicitantes (nombre, apellido, tipo_documento, numero_documento, email, telefono,
                                tipo_persona, razon_social, inmobiliaria_id, creado_por)
      VALUES (
        left(COALESCE(NULLIF(btrim(v_a->>'nombre'), ''), v_a->>'razon_social'), 100),
        left(COALESCE(v_a->>'apellido', ''), 100),
        (v_a->>'tipo_documento')::tipo_documento_id,
        v_a->>'numero_documento',
        left(v_a->>'email', 255),
        left(v_a->>'celular', 20),
        COALESCE(v_a->>'tipo_persona', 'natural')::tipo_persona,
        left(NULLIF(btrim(v_a->>'razon_social'), ''), 300),
        v_lote.inmobiliaria_id,
        v_lote.creado_por)
      RETURNING id INTO v_sol;
    END IF;

    -- Inmueble: el existente de la org que resolvió el procesamiento, o uno nuevo.
    v_inm := NULLIF(v_d->>'inmueble_id', '')::uuid;
    IF v_inm IS NOT NULL THEN
      PERFORM 1 FROM inmuebles WHERE id = v_inm AND inmobiliaria_id = v_lote.inmobiliaria_id FOR UPDATE;
      IF NOT FOUND THEN
        v_inm := NULL;
      ELSIF EXISTS (SELECT 1 FROM inmuebles i
                     WHERE i.id = v_inm AND (i.estado = 'ocupado' OR i.reservado_por_expediente_id IS NOT NULL))
         OR EXISTS (SELECT 1 FROM contratos c JOIN expedientes e ON e.id = c.expediente_id
                     WHERE e.inmueble_id = v_inm
                       AND c.estado IN ('pendiente_firma', 'firma_incompleta', 'firmado', 'vigente')) THEN
        v_conflicto := 'INMUEBLE_OCUPADO';
      END IF;
    END IF;

    IF v_inm IS NULL THEN
      v_codigo := left(NULLIF(btrim(v_d->>'codigo_interno'), ''), 30);
      IF v_codigo IS NULL OR EXISTS (SELECT 1 FROM inmuebles WHERE propietario_id = v_owner AND codigo = v_codigo) THEN
        v_codigo := v_lote.numero || '-' || lpad(f.n_fila::text, GREATEST(4, length(f.n_fila::text)), '0');
      END IF;
      INSERT INTO inmuebles (codigo, direccion, ciudad, departamento, tipo, uso, estrato, valor_arriendo,
                             administracion, estado, propietario_id, inmobiliaria_id, visible_vitrina)
      VALUES (
        v_codigo,
        left(v_d->>'direccion', 300),
        left(v_d->>'municipio', 100),
        left(v_d->>'departamento', 100),
        (v_d->>'tipo_inmueble')::tipo_inmueble,
        v_dest::uso_inmueble,
        (v_d->>'estrato')::smallint,
        (v_d->>'canon')::numeric,
        COALESCE((v_d->>'cuota_administracion')::numeric, 0),
        'ocupado',
        v_owner,
        v_lote.inmobiliaria_id,
        FALSE)
      RETURNING id INTO v_inm;
    ELSE
      -- Igual que bloquearInmuebleOcupado: ocupado y fuera de vitrina, sin revivir un 'inactivo'.
      UPDATE inmuebles SET estado = 'ocupado', visible_vitrina = FALSE
       WHERE id = v_inm AND estado <> 'inactivo';
    END IF;

    -- Expediente mínimo: nace cerrado (A2), no pasa por el trigger de cierre ni
    -- choca con idx_expediente_activo_solicitante_inmueble.
    INSERT INTO expedientes (inmueble_id, solicitante_id, estado, origen, inmobiliaria_id, creado_por,
                             fecha_inicio_contrato, duracion_contrato_meses, notas)
    VALUES (v_inm, v_sol, 'cerrado', 'migracion', v_lote.inmobiliaria_id, v_lote.creado_por,
            v_ini, v_meses, format('Migración de cartera: lote %s, fila %s.', v_lote.numero, f.n_fila))
    RETURNING id INTO v_exp;

    -- Contrato V3 vigente (A1, A6): numero CTO por trigger.
    INSERT INTO contratos (expediente_id, estado, origen, destinacion, iva_canon_pct, valor_arriendo,
                           fecha_inicio, fecha_fin, duracion_meses, fecha_firma,
                           storage_key_firmado, nombre_archivo_firmado, datos_variables)
    VALUES (
      v_exp, 'vigente', 'migracion', v_dest,
      CASE WHEN v_dest = 'vivienda' THEN 0 ELSE COALESCE((v_d->>'iva_canon_pct')::numeric, 0) END,
      (v_d->>'canon')::numeric,
      v_ini, v_fin, v_meses, p_activado_en,
      v_acta.storage_key_firmado,
      'Acta de migración ' || v_lote.numero || '.pdf',
      jsonb_build_object('migracion', jsonb_build_object(
        'lote_id', v_lote.id,
        'lote_numero', v_lote.numero,
        'fila_id', f.id,
        'n_fila', f.n_fila,
        'acta_id', v_acta.id,
        'modalidad', 'tradicional',
        'reportable', f.reportable,
        'tarifa_acta_pct', f.tarifa_acta_pct,
        'activado_en', p_activado_en)))
    RETURNING id INTO v_ctr;

    INSERT INTO contrato_historial_estados (contrato_id, estado_anterior, estado_nuevo, descripcion, motivo, usuario_id)
    VALUES (v_ctr, 'borrador', 'vigente',
            format('Fianza activada por migración de cartera: acta del lote %s firmada.', v_lote.numero),
            'migracion', NULL);

    UPDATE migracion_filas
       SET contrato_id = v_ctr,
           en_revision = en_revision OR v_conflicto IS NOT NULL,
           en_revision_motivo = COALESCE(v_conflicto, en_revision_motivo),
           tarifa_desde = COALESCE(tarifa_desde, v_hoy)
     WHERE id = f.id;

    IF v_conflicto IS NOT NULL THEN v_revision := v_revision + 1; END IF;
    v_res := v_res || jsonb_build_object('fila_id', f.id, 'contrato_id', v_ctr, 'inmueble_id', v_inm,
                                         'en_revision', v_conflicto IS NOT NULL);
  END LOOP;

  RETURN json_build_object(
    'lote_id', p_lote, 'ya_activo', FALSE, 'activado_en', p_activado_en,
    'activados', jsonb_array_length(v_res), 'en_revision', v_revision, 'contratos', v_res);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_activar_lote_migracion(uuid, timestamptz) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.fn_activar_lote_migracion(uuid, timestamptz) IS
  'Spec migración §4.1: activa todos los contratos del lote a la vez al firmarse el acta. Idempotente; conflictos tardíos -> fila en_revision.';

COMMIT;
