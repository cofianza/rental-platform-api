-- ============================================================
-- Contrato V4 (flujo anterior): decisiones del 2026-09-24.
--
-- P12 — Comisión de intermediación (V3 §8.3.6; Adenda 1 contratos §3.6.5): la
-- fija cada inmobiliaria en el contrato; 0 o vacía suprime la cláusula con
-- renumeración, y el propietario directo nunca la lleva. El API deja
-- inmobiliaria.comision_porcentaje vacío en esos casos.
-- ORDEN: correr esta migración ANTES de desplegar el API. Con el API anterior
-- ese campo siempre trae el 20 % global y la plantilla imprime lo mismo que
-- hoy; el API nuevo sin esta migración dejaría la cláusula 21 con el
-- porcentaje en blanco.
-- De paso, el bloque del arrendador, su firma y la cláusula de datos
-- personales no le ponen NIT ni representante legal a un propietario persona
-- natural: va con su documento.
--
-- Cobertura [PLATA]: la plantilla imprimía la cobertura según
-- modalidades_fianza (servicios, administración, cláusula penal; Plus también
-- daños). La documentación vigente dice que la fianza cubre SOLO el canon
-- (plantilla vigente, CUARTA Parágrafo Cuarto; Anexo §12; Adenda 1 contratos
-- §1.4): se cambian el texto y la tabla.
--
-- P31 — Fecha: la plantilla imprimía como fecha de suscripción la de
-- generación. Se reemplaza por el cierre del bloque XI del contrato vigente
-- (el V3 tampoco imprime fecha), remitiendo a la cláusula de firma de este y
-- con tantos ejemplares como partes firmantes (aquí también firma COFIANZA).
--
-- Firma: un firmante bloqueado en Auco (3 códigos fallidos) queda 'bloqueado'
-- (no es final: Cofianza lo desbloquea). Sin este valor el API solo avisa.
--
-- Idempotente: cada REPLACE solo actúa si encuentra el texto viejo, y los que
-- envuelven un texto que sigue presente llevan su guarda. Solo afecta
-- contratos generados o regenerados después.
-- ============================================================

-- 0. Estado de firmante 'bloqueado' (contrato_firmantes y solicitudes_firma comparten el enum).
ALTER TYPE estado_solicitud_firma ADD VALUE IF NOT EXISTS 'bloqueado';

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

-- 3. Propietario directo: se identifica con su documento, sin NIT ni
--    representante legal (cuadro de partes, firma y cláusula de datos personales).
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

UPDATE plantillas_contrato
SET contenido_html = REPLACE(
  contenido_html,
  '{{#if inmobiliaria.representante_legal}}representada legalmente por {{inmobiliaria.representante_legal}}. {{/if}}Domicilio:',
  '{{#if arrendador.es_inmobiliaria}}{{#if inmobiliaria.representante_legal}}representada legalmente por {{inmobiliaria.representante_legal}}. {{/if}}{{/if}}Domicilio:'
)
WHERE position('{{#if inmobiliaria.representante_legal}}representada legalmente por {{inmobiliaria.representante_legal}}. {{/if}}Domicilio:' in contenido_html) > 0;

UPDATE plantillas_contrato
SET contenido_html = REPLACE(
  contenido_html,
  'autorizan a {{inmobiliaria.razon_social}} (NIT {{inmobiliaria.nit}}) y a COFIANZA S.A.S.',
  'autorizan a {{inmobiliaria.razon_social}} ({{#if arrendador.es_inmobiliaria}}NIT {{inmobiliaria.nit}}{{else}}{{arrendador.tipo_documento_label}} {{arrendador.numero_documento}}{{/if}}) y a COFIANZA S.A.S.'
)
WHERE position('autorizan a {{inmobiliaria.razon_social}} (NIT {{inmobiliaria.nit}}) y a COFIANZA S.A.S.' in contenido_html) > 0;

-- 4. Cobertura: solo el canon (texto de la plantilla vigente y del Anexo §12).
UPDATE plantillas_contrato
SET contenido_html = REPLACE(
  contenido_html,
  '<p class="par"><span class="par-label">PARÁGRAFO PRIMERO — Alcance de la cobertura:</span> La fianza de COFIANZA S.A.S. cubre los siguientes conceptos dentro del periodo de vigencia del contrato y hasta el límite establecido en la modalidad de fianza aprobada según el Certificado de Riesgo COFIANZA (CRC):</p>
<table>
  <tr><th>Concepto</th><th>Cubierto por la fianza</th></tr>
  <tr><td>Cánones de arrendamiento impagos</td><td>{{cob.canones}}</td></tr>
  <tr><td>Servicios públicos domiciliarios impagos</td><td>{{cob.servicios}}</td></tr>
  <tr><td>Cuotas de administración de propiedad horizontal</td><td>{{cob.admin_ph}}</td></tr>
  <tr><td>Daños al inmueble imputables al arrendatario</td><td>{{cob.danos}}</td></tr>
  <tr><td>Cláusula penal por incumplimiento</td><td>{{cob.penal}}</td></tr>
</table>
<p>Los conceptos no marcados como cubiertos en la tabla anterior NO están incluidos en la fianza. COFIANZA S.A.S. no responderá por obligaciones que no hayan sido expresamente pactadas. Cualquier ampliación de cobertura deberá constar en el CRC correspondiente.</p>',
  '<p class="par"><span class="par-label">PARÁGRAFO PRIMERO — Alcance de la cobertura:</span> La fianza cubre el pago del canon de arrendamiento desde la fecha de mora hasta la restitución material del inmueble, con un tope máximo de dieciocho (18) cánones de arrendamiento, lo que ocurra primero. La cobertura comprende únicamente el canon de arrendamiento. NO están cubiertas las cuotas de administración, los servicios públicos, los daños al inmueble, los faltantes de inventario, la cláusula penal, los intereses moratorios, los gastos de cobranza, ni ningún otro concepto, salvo que se contraten expresamente como amparo adicional y así conste por escrito.</p>'
)
WHERE position('La fianza de COFIANZA S.A.S. cubre los siguientes conceptos dentro del periodo de vigencia del contrato' in contenido_html) > 0;

-- 5. Cobertura en la tabla: todas las modalidades cubren solo el canon (la
--    tabla de la plantilla, si alguien la conserva, y cualquier lectura futura).
UPDATE modalidades_fianza
SET cubre_canones = true, cubre_servicios = false, cubre_admin_ph = false,
    cubre_danos = false, cubre_penal = false, updated_at = now()
WHERE NOT cubre_canones OR cubre_servicios OR cubre_admin_ph OR cubre_danos OR cubre_penal;

ALTER TABLE modalidades_fianza ALTER COLUMN cubre_penal SET DEFAULT false;

-- 6. P31: sin fecha de suscripción; el cierre del bloque XI del contrato vigente.
UPDATE plantillas_contrato
SET contenido_html = REPLACE(
  contenido_html,
  '<p>En señal de conformidad con todo lo anterior, las partes suscriben el presente contrato en {{contrato.domicilio_contractual}}, a los {{contrato.fecha_firma_dia}} días del mes de {{contrato.fecha_firma_mes}} de {{contrato.fecha_firma_ano}}.</p>',
  '<p>El presente contrato se perfecciona con la firma de LAS PARTES. Cuando se suscriba de manera física, se firma en tantos ejemplares del mismo tenor como partes firmantes, uno para cada una. Cuando se suscriba mediante firma electrónica, se otorga en un único ejemplar electrónico del cual cada parte recibirá copia, en los términos de la Cláusula {{#if inmobiliaria.comision_porcentaje}}Vigésima Octava{{else}}Vigésima Séptima{{/if}}.</p>'
)
WHERE position('<p>En señal de conformidad con todo lo anterior, las partes suscriben el presente contrato en {{contrato.domicilio_contractual}}, a los {{contrato.fecha_firma_dia}} días del mes de {{contrato.fecha_firma_mes}} de {{contrato.fecha_firma_ano}}.</p>' in contenido_html) > 0;
