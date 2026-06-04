-- Consentimientos OPCIONALES (Paso 2 "Beneficios" de la autorización de datos).
-- No condicionan el servicio (Ley 1581 — finalidades opcionales). Se registran
-- al firmar la autorización, junto con la firma electrónica (OTP), como evidencia.

ALTER TABLE autorizaciones_habeas_data
  ADD COLUMN IF NOT EXISTS consent_analitica boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS consent_comercial boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS consent_historial_referencia boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN autorizaciones_habeas_data.consent_analitica IS
  'Finalidad opcional: analítica avanzada, segmentación y perfilamiento comercial.';
COMMENT ON COLUMN autorizaciones_habeas_data.consent_comercial IS
  'Finalidad opcional: comunicaciones comerciales, ofertas y mercadeo.';
COMMENT ON COLUMN autorizaciones_habeas_data.consent_historial_referencia IS
  'Finalidad opcional: compartir historial de buen pago como referencia ante terceros del ecosistema.';
