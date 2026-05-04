-- ============================================================
-- Soporte de persona jurídica para solicitantes facturando ante DIAN.
--
-- Hasta hoy el flujo del solicitante asumía persona natural y `legal_organization_code`
-- iba hardcodeado a '2' en facturacion.service.ts. Cuando un solicitante es una
-- empresa que arrienda (oficina, hospedaje corporativo, etc.) la factura DIAN
-- exigía razón social + DV + tribute_code y no había dónde guardar esos datos.
--
-- La columna `tipo_persona` ya existe (enum natural/juridica). Esta migración
-- agrega los campos que faltaban para soportar el flujo jurídica:
--
--   razon_social        Nombre legal de la empresa (DIAN: customer.company).
--                       Solo aplica cuando tipo_persona='juridica'.
--                       NOTA: la columna `empresa` que ya existía es la empresa
--                       empleadora del solicitante (cuando es persona natural
--                       y trabaja en algún sitio) — semánticamente distinta a
--                       razón social, por eso son columnas separadas.
--
--   digito_verificacion DV del NIT colombiano (1 dígito, 0-9). Aplica cuando
--                       tipo_persona='juridica' o cuando tipo_documento='nit'.
--
--   tribute_code        Código DIAN de responsabilidad fiscal (customer.tribute_code).
--                       'ZZ' = No aplica (default seguro para persona natural
--                       consumidor final). '01' = IVA, '04' = INC, 'ZA' = IVA+INC.
-- ============================================================

ALTER TABLE solicitantes
  ADD COLUMN IF NOT EXISTS razon_social        VARCHAR(300),
  ADD COLUMN IF NOT EXISTS digito_verificacion VARCHAR(2),
  ADD COLUMN IF NOT EXISTS tribute_code        VARCHAR(2) NOT NULL DEFAULT 'ZZ';

COMMENT ON COLUMN solicitantes.razon_social IS
  'Razón social de la empresa cuando tipo_persona=juridica. Va a customer.company en Factus/DIAN. Mutuamente excluyente con nombre+apellido (que aplica solo a persona natural).';

COMMENT ON COLUMN solicitantes.digito_verificacion IS
  'Dígito de verificación del NIT colombiano (1 char, 0-9). Va a customer.dv en Factus. Solo aplica cuando tipo_documento=nit (típicamente persona jurídica).';

COMMENT ON COLUMN solicitantes.tribute_code IS
  'Código DIAN de responsabilidad fiscal. Default ZZ=No aplica (persona natural consumidor final). Otros valores: 01=IVA, 04=INC, ZA=IVA+INC. Va a customer.tribute_code.';

-- Constraint de coherencia: si tipo_persona='juridica', razon_social no puede
-- ser NULL ni vacío. Para 'natural' no es obligatorio.
ALTER TABLE solicitantes
  DROP CONSTRAINT IF EXISTS solicitantes_juridica_razon_social_chk;

ALTER TABLE solicitantes
  ADD CONSTRAINT solicitantes_juridica_razon_social_chk CHECK (
    tipo_persona <> 'juridica'
    OR (razon_social IS NOT NULL AND length(trim(razon_social)) > 0)
  );
