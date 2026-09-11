-- ============================================================
-- firma_verificacion_identidad — biometria en la FIRMA del contrato
-- (Adenda 2 a la Politica V4.1, §9)
-- ------------------------------------------------------------
-- Antes de crear el sobre de Auco, el arrendatario confirma su identidad en
-- una pagina de Cofianza: lee el texto de consentimiento aprobado (§9.2) y
-- elige UNA de dos casillas excluyentes (§9.3). Si autoriza, se coteja su
-- selfie contra su cedula (AucoFace) con UMBRAL_SIMILITUD_BIOMETRICA (80 %).
--
-- NUNCA RECHAZA. Si no coincide, Auco no responde o la persona prefiere al
-- analista, el tramite sigue igual (se crea el sobre) y un analista de
-- Cofianza verifica por otro medio; si detecta suplantacion, cancela el
-- contrato. Solo actua con FIRMA_BIOMETRIA_ENABLED=true.
--
-- Una fila por persona y contrato. LAS IMAGENES NO SE GUARDAN: solo el
-- veredicto y el `code` de Auco (con el que Auco reproduce la evidencia), igual
-- que autorizacion_perfil_prospecto.biometria (20260907000003).
--
-- Control de acceso en capa de aplicacion (service_role bypassa RLS).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.firma_verificacion_identidad (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contrato_id       UUID NOT NULL REFERENCES public.contratos(id) ON DELETE CASCADE,
  -- Hoy solo el arrendatario: el co-titular no firma en Auco.
  rol               VARCHAR(20) NOT NULL CHECK (rol IN ('arrendatario', 'cotitular')),
  nombre            VARCHAR(200) NOT NULL,
  email             VARCHAR(255) NOT NULL,
  -- Documento con el que se envio el contrato: contra este se coteja.
  tipo_documento    VARCHAR(20),
  numero_documento  VARCHAR(30),
  token             VARCHAR(64) NOT NULL UNIQUE,
  token_expiracion  TIMESTAMPTZ NOT NULL,
  -- Quien presiono "Enviar a firma": el sobre de Auco sale a su nombre.
  enviado_por       UUID REFERENCES public.perfiles(id) ON DELETE SET NULL,
  estado            VARCHAR(20) NOT NULL DEFAULT 'pendiente'
                      CHECK (estado IN ('pendiente', 'verificada', 'no_coincide', 'no_verificada', 'omitida')),
  -- §9.3: opcion elegida, fecha y hora, IP, dispositivo y el texto exacto
  -- presentado (con su version). El historial completo queda en la bitacora.
  opcion            VARCHAR(20) CHECK (opcion IN ('autoriza', 'analista')),
  opcion_en         TIMESTAMPTZ,
  ip                VARCHAR(64),
  dispositivo       TEXT,
  texto_version     VARCHAR(40),
  texto             TEXT,
  -- Ultimo cotejo (ResumenBiometria de src/modules/autorizaciones/biometria.ts).
  resultado         JSONB,
  completada_en     TIMESTAMPTZ,
  -- Verificacion del analista cuando no quedo limpia.
  revision          VARCHAR(20) CHECK (revision IN ('confirmada', 'suplantacion')),
  revision_nota     TEXT,
  revisado_por      UUID REFERENCES public.perfiles(id) ON DELETE SET NULL,
  revisado_en       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS firma_verificacion_identidad_contrato_rol_unique
  ON public.firma_verificacion_identidad(contrato_id, rol);

ALTER TABLE public.firma_verificacion_identidad ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.firma_verificacion_identidad IS
  'Adenda 2 §9: verificacion de identidad (consentimiento + cotejo AucoFace) antes de la firma del contrato. Nunca rechaza. Sin imagenes. Ver src/modules/firma/verificacion-identidad.service.ts.';

-- ------------------------------------------------------------
-- ROLLBACK (manual, no se ejecuta aqui)
--
--   DROP TABLE IF EXISTS public.firma_verificacion_identidad;
