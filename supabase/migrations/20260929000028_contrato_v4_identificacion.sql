-- ============================================================
-- Contrato V4: identificación de las partes sin huecos.
-- Fecha: 2026-09-23 (revisión del sistema, hueco2-8)
--
-- La plantilla V4 (la activa) tenía fijo «C.C.:» para el arrendatario y el
-- co-titular (un extranjero quedaba identificado con cédula), ponía la cuenta
-- de pagos «a nombre de» la razón social aunque el titular real es otro, e
-- imprimía la matrícula del arrendador y la del inmueble aunque estuvieran
-- vacías («expedida por  el , representada legalmente por .»).
--
-- Variables nuevas que llena el contexto del API (desplegar el API ANTES):
--   arrendatario.tipo_documento_label, cotitular.tipo_documento_label,
--   inmobiliaria.cuenta_titular_nombre.
--
-- Solo afecta contratos generados a partir de ahora. Idempotente: cada
-- REPLACE solo actúa si encuentra el texto viejo.
-- ============================================================

-- 1. Tipo de documento del arrendatario y del co-titular (tabla y firmas).
UPDATE plantillas_contrato
SET contenido_html = REPLACE(
  contenido_html,
  'C.C.: {{arrendatario.cedula}}',
  '{{arrendatario.tipo_documento_label}}: {{arrendatario.cedula}}'
)
WHERE position('C.C.: {{arrendatario.cedula}}' in contenido_html) > 0;

UPDATE plantillas_contrato
SET contenido_html = REPLACE(
  contenido_html,
  'C.C.: {{cotitular.cedula}}',
  '{{cotitular.tipo_documento_label}}: {{cotitular.cedula}}'
)
WHERE position('C.C.: {{cotitular.cedula}}' in contenido_html) > 0;

-- 2. Cuenta para pagos a nombre del titular real de la cuenta.
UPDATE plantillas_contrato
SET contenido_html = REPLACE(
  contenido_html,
  'a nombre de {{inmobiliaria.razon_social}}',
  'a nombre de {{inmobiliaria.cuenta_titular_nombre}}'
)
WHERE position('a nombre de {{inmobiliaria.razon_social}}' in contenido_html) > 0;

-- 3. Matrícula de arrendador y representante legal solo si existen (un
--    propietario persona natural no tiene ninguno de los dos).
UPDATE plantillas_contrato
SET contenido_html = REPLACE(
  contenido_html,
  'Matrícula de Arrendador No. {{inmobiliaria.matricula_arrendador}} expedida por {{inmobiliaria.matricula_expedida_por}} el {{inmobiliaria.matricula_fecha}}, representada legalmente por {{inmobiliaria.representante_legal}}. Domicilio:',
  '{{#if inmobiliaria.matricula_arrendador}}Matrícula de Arrendador No. {{inmobiliaria.matricula_arrendador}}{{#if inmobiliaria.matricula_expedida_por}} expedida por {{inmobiliaria.matricula_expedida_por}}{{/if}}{{#if inmobiliaria.matricula_fecha}} el {{inmobiliaria.matricula_fecha}}{{/if}}, {{/if}}{{#if inmobiliaria.representante_legal}}representada legalmente por {{inmobiliaria.representante_legal}}. {{/if}}Domicilio:'
)
WHERE position('Matrícula de Arrendador No. {{inmobiliaria.matricula_arrendador}} expedida por {{inmobiliaria.matricula_expedida_por}} el {{inmobiliaria.matricula_fecha}}, representada legalmente por {{inmobiliaria.representante_legal}}. Domicilio:' in contenido_html) > 0;

-- 4. Matrícula inmobiliaria del inmueble solo si se capturó.
UPDATE plantillas_contrato
SET contenido_html = REPLACE(
  contenido_html,
  ' · Matrícula Inmobiliaria: {{inmueble.matricula_inmobiliaria}}',
  '{{#if inmueble.matricula_inmobiliaria}} · Matrícula Inmobiliaria: {{inmueble.matricula_inmobiliaria}}{{/if}}'
)
WHERE position(' · Matrícula Inmobiliaria: {{inmueble.matricula_inmobiliaria}}' in contenido_html) > 0
  AND position('{{#if inmueble.matricula_inmobiliaria}}' in contenido_html) = 0;
