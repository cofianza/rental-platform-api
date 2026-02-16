-- ============================================================
-- Habitar Propiedades 2.0 - Migración Inicial
-- Base de datos: Supabase PostgreSQL
-- Fecha: 2026-02-16
-- Tarea: HP-23 - Diseño de base de datos v1
-- ============================================================

-- ============================================================
-- 1. TIPOS ENUMERADOS
-- ============================================================

CREATE TYPE rol_usuario AS ENUM (
  'administrador',
  'operador_analista',
  'gerencia_consulta',
  'propietario',
  'inmobiliaria'
);

CREATE TYPE estado_usuario AS ENUM (
  'activo',
  'inactivo'
);

CREATE TYPE tipo_documento_id AS ENUM (
  'cc',       -- Cédula de ciudadanía
  'nit',      -- NIT (persona jurídica)
  'ce',       -- Cédula de extranjería
  'pasaporte'
);

CREATE TYPE tipo_inmueble AS ENUM (
  'apartamento',
  'casa',
  'oficina',
  'local'
);

CREATE TYPE uso_inmueble AS ENUM (
  'vivienda',
  'comercial'
);

CREATE TYPE estado_inmueble AS ENUM (
  'disponible',
  'en_estudio',
  'ocupado',
  'inactivo'
);

CREATE TYPE tipo_persona AS ENUM (
  'natural',
  'juridica'
);

CREATE TYPE estado_expediente AS ENUM (
  'borrador',
  'en_revision',
  'informacion_incompleta',
  'aprobado',
  'rechazado',
  'condicionado',
  'cerrado'
);

CREATE TYPE tipo_documento_archivo AS ENUM (
  'cedula_frontal',
  'cedula_posterior',
  'certificado_laboral',
  'comprobante_ingresos',
  'comprobante_domicilio',
  'referencias',
  'selfie_con_id',
  'otro'
);

CREATE TYPE estado_documento AS ENUM (
  'pendiente',
  'aprobado',
  'rechazado'
);

CREATE TYPE tipo_estudio AS ENUM (
  'individual',
  'con_coarrendatario'
);

CREATE TYPE proveedor_estudio AS ENUM (
  'transunion',
  'sifin',
  'datacredito',
  'manual'
);

CREATE TYPE resultado_estudio AS ENUM (
  'pendiente',
  'aprobado',
  'rechazado',
  'condicionado'
);

CREATE TYPE estado_contrato AS ENUM (
  'borrador',
  'pendiente_firma',
  'firmado',
  'vigente',
  'finalizado',
  'cancelado'
);

CREATE TYPE tipo_firmante AS ENUM (
  'arrendatario',
  'propietario',
  'codeudor'
);

CREATE TYPE tipo_pago AS ENUM (
  'estudio',
  'deposito',
  'mensualidad'
);

CREATE TYPE estado_pago AS ENUM (
  'pendiente',
  'pagado',
  'fallido',
  'reembolsado'
);

CREATE TYPE estado_factura AS ENUM (
  'solicitada',
  'emitida',
  'cancelada'
);

CREATE TYPE tipo_evento_timeline AS ENUM (
  'creacion',
  'asignacion',
  'documento',
  'estado',
  'comentario',
  'estudio',
  'contrato',
  'firma',
  'pago'
);

-- ============================================================
-- 2. FUNCIONES AUXILIARES
-- ============================================================

-- Función para actualizar updated_at automáticamente
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Secuencia para códigos de inmueble (INM-001, INM-002, ...)
CREATE SEQUENCE inmueble_codigo_seq START 1;

-- Función para generar código de inmueble
CREATE OR REPLACE FUNCTION generar_codigo_inmueble()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.codigo IS NULL THEN
    NEW.codigo = 'INM-' || LPAD(NEXTVAL('inmueble_codigo_seq')::TEXT, 3, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Secuencia para números de expediente
CREATE SEQUENCE expediente_numero_seq START 1;

-- Función para generar número de expediente (EXP-YYYY-XXXX)
CREATE OR REPLACE FUNCTION generar_numero_expediente()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.numero IS NULL THEN
    NEW.numero = 'EXP-' || EXTRACT(YEAR FROM NOW())::TEXT || '-' || LPAD(NEXTVAL('expediente_numero_seq')::TEXT, 4, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 3. TABLAS
-- ============================================================

-- -------------------------------------------------------
-- 3.1 PERFILES (extiende auth.users de Supabase Auth)
-- -------------------------------------------------------
CREATE TABLE perfiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  nombre      VARCHAR(100) NOT NULL,
  apellido    VARCHAR(100) NOT NULL,
  telefono    VARCHAR(20),
  tipo_documento tipo_documento_id,
  numero_documento VARCHAR(20),
  rol         rol_usuario NOT NULL DEFAULT 'operador_analista',
  estado      estado_usuario NOT NULL DEFAULT 'activo',
  avatar_url  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER perfiles_updated_at
  BEFORE UPDATE ON perfiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Trigger: crear perfil automáticamente cuando se registra un usuario en Supabase Auth
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.perfiles (id, nombre, apellido, rol)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'nombre', ''),
    COALESCE(NEW.raw_user_meta_data->>'apellido', ''),
    COALESCE((NEW.raw_user_meta_data->>'rol')::rol_usuario, 'operador_analista')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- -------------------------------------------------------
-- 3.2 INMUEBLES
-- -------------------------------------------------------
CREATE TABLE inmuebles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo          VARCHAR(10) UNIQUE,
  direccion       VARCHAR(300) NOT NULL,
  ciudad          VARCHAR(100) NOT NULL,
  barrio          VARCHAR(100),
  departamento    VARCHAR(100) NOT NULL,
  tipo            tipo_inmueble NOT NULL,
  uso             uso_inmueble NOT NULL DEFAULT 'vivienda',
  estrato         SMALLINT NOT NULL CHECK (estrato BETWEEN 1 AND 6),
  valor_arriendo  NUMERIC(12,2) NOT NULL CHECK (valor_arriendo > 0),
  valor_comercial NUMERIC(14,2),
  administracion  NUMERIC(10,2) DEFAULT 0,
  area_m2         NUMERIC(8,2),
  habitaciones    SMALLINT DEFAULT 0,
  banos           SMALLINT DEFAULT 0,
  parqueadero     BOOLEAN DEFAULT FALSE,
  descripcion     TEXT,
  notas_internas  TEXT,
  estado          estado_inmueble NOT NULL DEFAULT 'disponible',
  propietario_id  UUID NOT NULL REFERENCES perfiles(id),
  visible_vitrina BOOLEAN NOT NULL DEFAULT FALSE,
  foto_fachada_url TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER inmuebles_updated_at
  BEFORE UPDATE ON inmuebles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER inmuebles_generar_codigo
  BEFORE INSERT ON inmuebles
  FOR EACH ROW EXECUTE FUNCTION generar_codigo_inmueble();

-- -------------------------------------------------------
-- 3.3 SOLICITANTES
-- -------------------------------------------------------
CREATE TABLE solicitantes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre              VARCHAR(100) NOT NULL,
  apellido            VARCHAR(100) NOT NULL,
  tipo_documento      tipo_documento_id NOT NULL DEFAULT 'cc',
  numero_documento    VARCHAR(20) NOT NULL,
  email               VARCHAR(255) NOT NULL,
  telefono            VARCHAR(20),
  tipo_persona        tipo_persona NOT NULL DEFAULT 'natural',
  direccion           VARCHAR(300),
  departamento        VARCHAR(100),
  ciudad              VARCHAR(100),
  ocupacion           VARCHAR(100),
  actividad_economica VARCHAR(200),
  empresa             VARCHAR(200),
  ingresos_mensuales  NUMERIC(12,2),
  parentesco          VARCHAR(50),
  nivel_educativo     VARCHAR(100),
  habitara_inmueble   BOOLEAN DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER solicitantes_updated_at
  BEFORE UPDATE ON solicitantes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- -------------------------------------------------------
-- 3.4 EXPEDIENTES
-- -------------------------------------------------------
CREATE TABLE expedientes (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  numero                  VARCHAR(20) UNIQUE,
  inmueble_id             UUID NOT NULL REFERENCES inmuebles(id),
  solicitante_id          UUID NOT NULL REFERENCES solicitantes(id),
  codeudor_nombre         VARCHAR(200),
  codeudor_tipo_documento tipo_documento_id,
  codeudor_documento      VARCHAR(20),
  codeudor_parentesco     VARCHAR(50),
  estado                  estado_expediente NOT NULL DEFAULT 'borrador',
  analista_id             UUID REFERENCES perfiles(id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER expedientes_updated_at
  BEFORE UPDATE ON expedientes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER expedientes_generar_numero
  BEFORE INSERT ON expedientes
  FOR EACH ROW EXECUTE FUNCTION generar_numero_expediente();

-- -------------------------------------------------------
-- 3.5 DOCUMENTOS
-- -------------------------------------------------------
CREATE TABLE documentos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expediente_id   UUID NOT NULL REFERENCES expedientes(id) ON DELETE CASCADE,
  tipo            tipo_documento_archivo NOT NULL,
  archivo_url     TEXT NOT NULL,
  nombre_original VARCHAR(255) NOT NULL,
  tipo_mime       VARCHAR(100),
  tamano_bytes    BIGINT,
  estado          estado_documento NOT NULL DEFAULT 'pendiente',
  motivo_rechazo  TEXT,
  version         SMALLINT NOT NULL DEFAULT 1,
  validado_por    UUID REFERENCES perfiles(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -------------------------------------------------------
-- 3.6 ESTUDIOS DE RIESGO
-- -------------------------------------------------------
CREATE TABLE estudios (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expediente_id           UUID NOT NULL REFERENCES expedientes(id),
  tipo                    tipo_estudio NOT NULL DEFAULT 'individual',
  proveedor               proveedor_estudio NOT NULL DEFAULT 'manual',
  resultado               resultado_estudio NOT NULL DEFAULT 'pendiente',
  score                   INTEGER,
  observaciones           TEXT,
  certificado_url         TEXT,
  codigo_qr               TEXT,
  duracion_contrato_meses SMALLINT,
  solicitado_por          UUID REFERENCES perfiles(id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -------------------------------------------------------
-- 3.7 PLANTILLAS DE CONTRATO
-- -------------------------------------------------------
CREATE TABLE plantillas_contrato (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre      VARCHAR(200) NOT NULL,
  descripcion TEXT,
  contenido_url TEXT,
  variables   JSONB DEFAULT '[]'::JSONB,
  activa      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER plantillas_contrato_updated_at
  BEFORE UPDATE ON plantillas_contrato
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- -------------------------------------------------------
-- 3.8 CONTRATOS
-- -------------------------------------------------------
CREATE TABLE contratos (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expediente_id       UUID NOT NULL REFERENCES expedientes(id),
  plantilla_id        UUID REFERENCES plantillas_contrato(id),
  version             SMALLINT NOT NULL DEFAULT 1,
  estado              estado_contrato NOT NULL DEFAULT 'borrador',
  contenido_url       TEXT,
  documento_firmado_url TEXT,
  fecha_inicio        DATE,
  fecha_fin           DATE,
  duracion_meses      SMALLINT,
  valor_arriendo      NUMERIC(12,2),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER contratos_updated_at
  BEFORE UPDATE ON contratos
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- -------------------------------------------------------
-- 3.9 FIRMAS
-- -------------------------------------------------------
CREATE TABLE firmas (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contrato_id     UUID NOT NULL REFERENCES contratos(id) ON DELETE CASCADE,
  tipo_firmante   tipo_firmante NOT NULL,
  nombre_firmante VARCHAR(200) NOT NULL,
  email_firmante  VARCHAR(255),
  enlace_firma    TEXT,
  codigo_otp      VARCHAR(10),
  otp_expiracion  TIMESTAMPTZ,
  firmado_en      TIMESTAMPTZ,
  ip_firmante     VARCHAR(45),
  user_agent      TEXT,
  evidencia_url   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -------------------------------------------------------
-- 3.10 PAGOS
-- -------------------------------------------------------
CREATE TABLE pagos (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expediente_id       UUID NOT NULL REFERENCES expedientes(id),
  tipo                tipo_pago NOT NULL,
  monto               NUMERIC(12,2) NOT NULL CHECK (monto > 0),
  estado              estado_pago NOT NULL DEFAULT 'pendiente',
  referencia_pasarela VARCHAR(255),
  metodo_pago         VARCHAR(50),
  comprobante_url     TEXT,
  fecha_pago          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -------------------------------------------------------
-- 3.11 FACTURAS
-- -------------------------------------------------------
CREATE TABLE facturas (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pago_id         UUID REFERENCES pagos(id),
  expediente_id   UUID NOT NULL REFERENCES expedientes(id),
  numero_factura  VARCHAR(50),
  razon_social    VARCHAR(300),
  nit             VARCHAR(20),
  direccion_fiscal VARCHAR(300),
  estado          estado_factura NOT NULL DEFAULT 'solicitada',
  archivo_url     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER facturas_updated_at
  BEFORE UPDATE ON facturas
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- -------------------------------------------------------
-- 3.12 BITÁCORA DE AUDITORÍA
-- -------------------------------------------------------
CREATE TABLE bitacora (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id  UUID REFERENCES perfiles(id),
  accion      VARCHAR(100) NOT NULL,
  entidad     VARCHAR(50) NOT NULL,
  entidad_id  UUID,
  detalle     JSONB,
  ip          VARCHAR(45),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -------------------------------------------------------
-- 3.13 COMENTARIOS
-- -------------------------------------------------------
CREATE TABLE comentarios (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expediente_id   UUID NOT NULL REFERENCES expedientes(id) ON DELETE CASCADE,
  usuario_id      UUID NOT NULL REFERENCES perfiles(id),
  texto           TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -------------------------------------------------------
-- 3.14 EVENTOS DE TIMELINE
-- -------------------------------------------------------
CREATE TABLE eventos_timeline (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expediente_id   UUID NOT NULL REFERENCES expedientes(id) ON DELETE CASCADE,
  tipo            tipo_evento_timeline NOT NULL,
  descripcion     TEXT NOT NULL,
  usuario_id      UUID REFERENCES perfiles(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 4. ÍNDICES
-- ============================================================

-- Índices únicos (ya definidos por UNIQUE constraints en columnas)
-- perfiles: email está en auth.users (manejado por Supabase Auth)
-- inmuebles.codigo: UNIQUE constraint
-- expedientes.numero: UNIQUE constraint

-- Índices de búsqueda por relación
CREATE INDEX idx_inmuebles_propietario ON inmuebles(propietario_id);
CREATE INDEX idx_inmuebles_estado ON inmuebles(estado);
CREATE INDEX idx_inmuebles_ciudad ON inmuebles(ciudad);
CREATE INDEX idx_inmuebles_visible ON inmuebles(visible_vitrina) WHERE visible_vitrina = TRUE;

CREATE INDEX idx_expedientes_inmueble ON expedientes(inmueble_id);
CREATE INDEX idx_expedientes_solicitante ON expedientes(solicitante_id);
CREATE INDEX idx_expedientes_analista ON expedientes(analista_id);
CREATE INDEX idx_expedientes_estado ON expedientes(estado);

CREATE INDEX idx_documentos_expediente ON documentos(expediente_id);
CREATE INDEX idx_documentos_estado ON documentos(estado);

CREATE INDEX idx_estudios_expediente ON estudios(expediente_id);

CREATE INDEX idx_contratos_expediente ON contratos(expediente_id);

CREATE INDEX idx_firmas_contrato ON firmas(contrato_id);

CREATE INDEX idx_pagos_expediente ON pagos(expediente_id);
CREATE INDEX idx_pagos_estado ON pagos(estado);

CREATE INDEX idx_facturas_expediente ON facturas(expediente_id);
CREATE INDEX idx_facturas_pago ON facturas(pago_id);

CREATE INDEX idx_bitacora_usuario ON bitacora(usuario_id);
CREATE INDEX idx_bitacora_entidad ON bitacora(entidad, entidad_id);
CREATE INDEX idx_bitacora_created ON bitacora(created_at DESC);

CREATE INDEX idx_comentarios_expediente ON comentarios(expediente_id);

CREATE INDEX idx_eventos_timeline_expediente ON eventos_timeline(expediente_id);
CREATE INDEX idx_eventos_timeline_created ON eventos_timeline(created_at DESC);

-- ============================================================
-- 5. ROW LEVEL SECURITY (habilitado, políticas se agregan después)
-- ============================================================

ALTER TABLE perfiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE inmuebles ENABLE ROW LEVEL SECURITY;
ALTER TABLE solicitantes ENABLE ROW LEVEL SECURITY;
ALTER TABLE expedientes ENABLE ROW LEVEL SECURITY;
ALTER TABLE documentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE estudios ENABLE ROW LEVEL SECURITY;
ALTER TABLE plantillas_contrato ENABLE ROW LEVEL SECURITY;
ALTER TABLE contratos ENABLE ROW LEVEL SECURITY;
ALTER TABLE firmas ENABLE ROW LEVEL SECURITY;
ALTER TABLE pagos ENABLE ROW LEVEL SECURITY;
ALTER TABLE facturas ENABLE ROW LEVEL SECURITY;
ALTER TABLE bitacora ENABLE ROW LEVEL SECURITY;
ALTER TABLE comentarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventos_timeline ENABLE ROW LEVEL SECURITY;

-- Política temporal: permitir acceso completo al service_role (backend)
-- Las políticas granulares por rol se implementan en HP-30 (Setup backend)
CREATE POLICY "Service role full access" ON perfiles FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "Service role full access" ON inmuebles FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "Service role full access" ON solicitantes FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "Service role full access" ON expedientes FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "Service role full access" ON documentos FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "Service role full access" ON estudios FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "Service role full access" ON plantillas_contrato FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "Service role full access" ON contratos FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "Service role full access" ON firmas FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "Service role full access" ON pagos FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "Service role full access" ON facturas FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "Service role full access" ON bitacora FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "Service role full access" ON comentarios FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "Service role full access" ON eventos_timeline FOR ALL USING (TRUE) WITH CHECK (TRUE);
