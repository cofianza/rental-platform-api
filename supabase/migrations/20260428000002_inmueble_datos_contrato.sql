-- ============================================================
-- Datos del inmueble que afectan al contrato de arrendamiento.
--
-- Antes de esto, buildContratoContext infería propiedad_horizontal
-- por una heurística (administracion > 0) y siempre asumía
-- cuarto_util = false. Estos campos permiten al propietario/inmobiliaria
-- declararlo explícitamente en el formulario del inmueble:
--
--   propiedad_horizontal: NULL = no especificado (cae a heurística);
--                         TRUE/FALSE = override explícito.
--   cuarto_util: si el inmueble incluye cuarto útil aparte del parqueadero.
--   ubicacion_detallada: redacción larga de la ubicación para la cláusula
--                        SEGUNDA del contrato. Si está vacío se construye
--                        automáticamente con dirección + barrio + ciudad.
-- ============================================================

ALTER TABLE inmuebles
  ADD COLUMN IF NOT EXISTS propiedad_horizontal BOOLEAN,
  ADD COLUMN IF NOT EXISTS cuarto_util BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ubicacion_detallada TEXT;

COMMENT ON COLUMN inmuebles.propiedad_horizontal IS 'Si el inmueble esta sometido a regimen de propiedad horizontal (clausula PRIMERA del contrato). NULL = inferir por heuristica (administracion > 0).';
COMMENT ON COLUMN inmuebles.cuarto_util IS 'Si el inmueble incluye cuarto util como uso conexo (paragrafo clausula SEGUNDA del contrato).';
COMMENT ON COLUMN inmuebles.ubicacion_detallada IS 'Texto libre para la clausula SEGUNDA del contrato. Si esta vacio se construye automaticamente con direccion + barrio + ciudad + departamento.';
