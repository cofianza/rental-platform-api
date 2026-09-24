-- ============================================================
-- Contrato V4 (flujo anterior): decisiones del 2026-09-24.
--
-- P12 — Comisión de intermediación (V3 §8.3.6; Adenda 1 contratos §3.6.5): la
-- fija cada inmobiliaria en el contrato; 0 o vacía suprime la cláusula con
-- renumeración, y el propietario directo nunca la lleva. El API deja
-- inmobiliaria.comision_porcentaje vacío en esos casos. Con el API anterior
-- ese campo siempre traía el 20 % global, así que la plantilla imprime lo
-- mismo que hoy hasta que salga el API nuevo (funciona antes y después).
-- De paso, el bloque del arrendador y su firma no le ponen NIT ni
-- representante legal a un propietario persona natural.
--
-- Idempotente: cada REPLACE solo actúa si encuentra el texto viejo, y los que
-- envuelven un texto que sigue presente llevan su guarda. Solo afecta
-- contratos generados o regenerados después.
-- ============================================================

-- 1. P12: la cláusula de comisión solo con porcentaje (título y párrafo).
UPDATE plantillas_contrato
SET contenido_html = REPLACE(
  contenido_html,
  '<h2>Cláusula Vigésima Primera. Comisión inmobiliaria</h2>',
  '{{#if inmobiliaria.comision_porcentaje}}<h2>Cláusula Vigésima Primera. Comisión inmobiliaria</h2>{{/if}}'
)
WHERE position('<h2>Cláusula Vigésima Primera. Comisión inmobiliaria</h2>' in contenido_html) > 0
  AND position('{{#if inmobiliaria.comision_porcentaje}}<h2>Cláusula Vigésima Primera' in contenido_html) = 0;

UPDATE plantillas_contrato
SET contenido_html = REPLACE(
  contenido_html,
  '<p>EL ARRENDATARIO pagará a EL ARRENDADOR un porcentaje equivalente al {{inmobiliaria.comision_porcentaje}} más IVA sobre el canon acordado, por concepto de servicios inmobiliarios de intermediación, cancelado una única vez al inicio del contrato de arrendamiento.</p>',
  '{{#if inmobiliaria.comision_porcentaje}}<p>EL ARRENDATARIO pagará a EL ARRENDADOR un porcentaje equivalente al {{inmobiliaria.comision_porcentaje}} más IVA sobre el canon acordado, por concepto de servicios inmobiliarios de intermediación, cancelado una única vez al inicio del contrato de arrendamiento.</p>{{/if}}'
)
WHERE position('<p>EL ARRENDATARIO pagará a EL ARRENDADOR un porcentaje equivalente al {{inmobiliaria.comision_porcentaje}} más IVA sobre el canon acordado, por concepto de servicios inmobiliarios de intermediación, cancelado una única vez al inicio del contrato de arrendamiento.</p>' in contenido_html) > 0
  AND position('{{#if inmobiliaria.comision_porcentaje}}<p>EL ARRENDATARIO pagará' in contenido_html) = 0;

-- 2. P12: sin la cláusula de comisión, las siguientes se renumeran.
UPDATE plantillas_contrato
SET contenido_html = REPLACE(
  contenido_html,
  '<h2>Cláusula Vigésima Segunda. Imputación del pago</h2>',
  '<h2>Cláusula {{#if inmobiliaria.comision_porcentaje}}Vigésima Segunda{{else}}Vigésima Primera{{/if}}. Imputación del pago</h2>'
)
WHERE position('<h2>Cláusula Vigésima Segunda. Imputación del pago</h2>' in contenido_html) > 0;

UPDATE plantillas_contrato
SET contenido_html = REPLACE(
  contenido_html,
  '<h2>Cláusula Vigésima Tercera. Autorización para reportar a centrales de riesgo</h2>',
  '<h2>Cláusula {{#if inmobiliaria.comision_porcentaje}}Vigésima Tercera{{else}}Vigésima Segunda{{/if}}. Autorización para reportar a centrales de riesgo</h2>'
)
WHERE position('<h2>Cláusula Vigésima Tercera. Autorización para reportar a centrales de riesgo</h2>' in contenido_html) > 0;

UPDATE plantillas_contrato
SET contenido_html = REPLACE(
  contenido_html,
  '<h2>Cláusula Vigésima Cuarta. Tratamiento de datos personales</h2>',
  '<h2>Cláusula {{#if inmobiliaria.comision_porcentaje}}Vigésima Cuarta{{else}}Vigésima Tercera{{/if}}. Tratamiento de datos personales</h2>'
)
WHERE position('<h2>Cláusula Vigésima Cuarta. Tratamiento de datos personales</h2>' in contenido_html) > 0;

UPDATE plantillas_contrato
SET contenido_html = REPLACE(
  contenido_html,
  '<h2>Cláusula Vigésima Quinta. Compra del inmueble arrendado</h2>',
  '<h2>Cláusula {{#if inmobiliaria.comision_porcentaje}}Vigésima Quinta{{else}}Vigésima Cuarta{{/if}}. Compra del inmueble arrendado</h2>'
)
WHERE position('<h2>Cláusula Vigésima Quinta. Compra del inmueble arrendado</h2>' in contenido_html) > 0;

UPDATE plantillas_contrato
SET contenido_html = REPLACE(
  contenido_html,
  '<h2>Cláusula Vigésima Sexta. Mérito ejecutivo</h2>',
  '<h2>Cláusula {{#if inmobiliaria.comision_porcentaje}}Vigésima Sexta{{else}}Vigésima Quinta{{/if}}. Mérito ejecutivo</h2>'
)
WHERE position('<h2>Cláusula Vigésima Sexta. Mérito ejecutivo</h2>' in contenido_html) > 0;

UPDATE plantillas_contrato
SET contenido_html = REPLACE(
  contenido_html,
  '<h2>Cláusula Vigésima Séptima. Notificaciones y domicilio contractual</h2>',
  '<h2>Cláusula {{#if inmobiliaria.comision_porcentaje}}Vigésima Séptima{{else}}Vigésima Sexta{{/if}}. Notificaciones y domicilio contractual</h2>'
)
WHERE position('<h2>Cláusula Vigésima Séptima. Notificaciones y domicilio contractual</h2>' in contenido_html) > 0;

UPDATE plantillas_contrato
SET contenido_html = REPLACE(
  contenido_html,
  '<h2>Cláusula Vigésima Octava. Firma y perfeccionamiento del contrato</h2>',
  '<h2>Cláusula {{#if inmobiliaria.comision_porcentaje}}Vigésima Octava{{else}}Vigésima Séptima{{/if}}. Firma y perfeccionamiento del contrato</h2>'
)
WHERE position('<h2>Cláusula Vigésima Octava. Firma y perfeccionamiento del contrato</h2>' in contenido_html) > 0;

UPDATE plantillas_contrato
SET contenido_html = REPLACE(
  contenido_html,
  '<h2>Cláusula Vigésima Novena. Integralidad del acuerdo</h2>',
  '<h2>Cláusula {{#if inmobiliaria.comision_porcentaje}}Vigésima Novena{{else}}Vigésima Octava{{/if}}. Integralidad del acuerdo</h2>'
)
WHERE position('<h2>Cláusula Vigésima Novena. Integralidad del acuerdo</h2>' in contenido_html) > 0;

-- 3. Propietario directo: se identifica con su documento, sin NIT ni representante legal.
UPDATE plantillas_contrato
SET contenido_html = REPLACE(
  contenido_html,
  '{{inmobiliaria.razon_social}}, NIT {{inmobiliaria.nit}}, {{#if inmobiliaria.matricula_arrendador}}',
  '{{inmobiliaria.razon_social}}, {{#if arrendador.es_inmobiliaria}}NIT {{inmobiliaria.nit}}{{else}}identificado(a) con {{arrendador.tipo_documento_label}} {{arrendador.numero_documento}}{{/if}}, {{#if inmobiliaria.matricula_arrendador}}'
)
WHERE position('{{inmobiliaria.razon_social}}, NIT {{inmobiliaria.nit}}, {{#if inmobiliaria.matricula_arrendador}}' in contenido_html) > 0;

UPDATE plantillas_contrato
SET contenido_html = REPLACE(
  contenido_html,
  '<br>NIT: {{inmobiliaria.nit}}<br>{{inmobiliaria.representante_legal}} — Representante Legal</p>',
  '<br>{{#if arrendador.es_inmobiliaria}}NIT: {{inmobiliaria.nit}}<br>{{inmobiliaria.representante_legal}} — Representante Legal{{else}}{{arrendador.tipo_documento_label}}: {{arrendador.numero_documento}}{{/if}}</p>'
)
WHERE position('<br>NIT: {{inmobiliaria.nit}}<br>{{inmobiliaria.representante_legal}} — Representante Legal</p>' in contenido_html) > 0;
