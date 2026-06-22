-- ============================================================
-- Firma multi-parte de contratos: tabla de firmantes
-- ------------------------------------------------------------
-- Hoy el contrato lo firma una sola parte (el arrendatario). Para la firma
-- multi-parte (arrendatario + arrendador + Cofianza) introducimos una tabla
-- de firmantes: UNA fila por parte de un contrato.
--
-- Modelo elegido (M1): UN solo documento/sobre en Auco con varios firmantes
-- (signProfile[]). `solicitudes_firma` sigue siendo el SOBRE (una fila por
-- contrato, con el auco_document_code compartido); `contrato_firmantes` lleva
-- el detalle por parte. El contrato pasa a 'firmado' solo cuando TODAS las
-- filas de contrato_firmantes estan 'firmado'. El orden de firma (secuencial)
-- se modela con `orden` y se traduce al campo `order` de cada signProfile.
--
-- Reutilizamos el enum existente `estado_solicitud_firma` para el estado por
-- parte. El indice unico `solicitudes_firma_contrato_activa_unique` NO se
-- toca: bajo M1 sigue habiendo un solo sobre activo por contrato.
--
-- IMPORTANTE: control de acceso en capa de aplicacion (service_role bypassa RLS).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.contrato_firmantes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contrato_id         UUID NOT NULL REFERENCES public.contratos(id) ON DELETE CASCADE,
  -- El sobre Auco que agrupa a todos los firmantes del contrato (M1).
  solicitud_firma_id  UUID REFERENCES public.solicitudes_firma(id) ON DELETE SET NULL,
  rol_firmante        VARCHAR(20) NOT NULL
                        CHECK (rol_firmante IN ('arrendatario', 'arrendador', 'cofianza')),
  nombre              VARCHAR(200) NOT NULL,
  email               VARCHAR(255) NOT NULL,
  telefono            VARCHAR(20),
  tipo_documento      VARCHAR(20),
  numero_documento    VARCHAR(30),
  country             VARCHAR(5),
  -- Orden de firma (1 = primero). Secuencial: arrendatario=1, arrendador=2, cofianza=3.
  orden               SMALLINT NOT NULL DEFAULT 1,
  estado              estado_solicitud_firma NOT NULL DEFAULT 'pendiente',
  -- Id que Auco asigna a este firmante dentro del documento (para mapear el
  -- webhook/poll signProfile[] -> esta fila).
  auco_signer_id      VARCHAR(100),
  firmado_en          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Una sola fila por (contrato, rol): no se duplica una parte.
CREATE UNIQUE INDEX IF NOT EXISTS contrato_firmantes_contrato_rol_unique
  ON public.contrato_firmantes(contrato_id, rol_firmante);
CREATE INDEX IF NOT EXISTS idx_contrato_firmantes_contrato
  ON public.contrato_firmantes(contrato_id);
CREATE INDEX IF NOT EXISTS idx_contrato_firmantes_solicitud
  ON public.contrato_firmantes(solicitud_firma_id);

COMMENT ON TABLE public.contrato_firmantes IS
  'Firmantes de un contrato (multi-parte): una fila por parte (arrendatario/arrendador/cofianza). M1: un solo sobre Auco (solicitudes_firma) agrupa a todos. El contrato pasa a firmado cuando todas las filas estan firmado.';
