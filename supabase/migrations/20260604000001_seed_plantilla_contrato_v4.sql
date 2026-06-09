-- ============================================================
-- Seed (Fase 1): plantilla del Contrato de Arrendamiento COFIANZA V4.0
-- Fuente: htmls/CONTRATO_ARRENDAMIENTO_COFIANZA_V4_handoff.docx
--
-- Se inserta como plantilla NUEVA e INACTIVA (activa = false) para NO romper
-- la generación de contratos actual. El admin puede previsualizarla/activarla
-- desde /plantillas-contrato cuando se completen las Fases 2 y 3 (mapeo del
-- contexto de variables y datos nuevos: modalidad de fianza, co-titular,
-- comisión/prima, cobertura CRC, reparto de servicios, canon en letras).
--
-- Variables: sintaxis del templateEngine ({{ns.campo}} con punto + {{#if}}).
-- Las variables que el contexto aún no provee se renderizan como vacío.
-- ============================================================

INSERT INTO plantillas_contrato (nombre, descripcion, contenido_html, variables, activa)
VALUES (
  'Contrato de Arrendamiento COFIANZA V4.0',
  'Contrato de arrendamiento de vivienda con COFIANZA S.A.S. como fiador solidario sin beneficio de excusión (V4.0, 2026). Cargada en Fase 1 — variables nuevas pendientes de mapear.',
  $contrato$<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<style>
  @page { size: Letter; margin: 2cm; }
  body { font-family: "Times New Roman", serif; font-size: 10.5pt; line-height: 1.4; color: #111; }
  .header { text-align: center; margin-bottom: 14px; }
  .header .logo { width: 110px; max-height: 80px; object-fit: contain; margin-bottom: 6px; }
  h1 { font-size: 13pt; font-weight: bold; text-transform: uppercase; margin: 0; }
  .subtitulo { font-size: 10.5pt; font-style: italic; margin: 4px 0 0 0; }
  .version { font-size: 9.5pt; color: #555; margin: 2px 0 0 0; }
  h2 { font-size: 11pt; font-weight: bold; margin: 16px 0 6px 0; text-transform: uppercase; }
  p { margin: 7px 0; text-align: justify; }
  .par { margin: 6px 0; text-align: justify; }
  .par-label { font-weight: bold; }
  ul, ol { padding-left: 22px; margin: 6px 0; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 9.5pt; }
  th, td { border: 1px solid #888; padding: 4px 7px; text-align: left; vertical-align: top; }
  th { background: #f0f0f0; font-weight: bold; }
  table.ident td.k { font-weight: bold; text-transform: uppercase; width: 26%; background: #f7f7f7; }
  .firma-block { margin-top: 30px; page-break-inside: avoid; }
  .firma-line { border-top: 1px solid #000; width: 290px; margin-top: 26px; margin-bottom: 3px; }
  .small { font-size: 9pt; color: #444; }
</style>
</head>
<body>

<div class="header">
  {{#if inmobiliaria.logo_url}}<img src="{{inmobiliaria.logo_url}}" class="logo" alt="Logo arrendador">{{/if}}
  <h1>Contrato de Arrendamiento de Inmueble Destinado a Vivienda</h1>
  <p class="subtitulo">Con vinculación de COFIANZA S.A.S. como Fiador Solidario sin Beneficio de Excusión</p>
  <p class="version">Versión 4.0 — 2026</p>
</div>

<h2>Identificación de las partes y del inmueble</h2>
<table class="ident">
  <tr><td class="k">Arrendador</td><td>{{inmobiliaria.razon_social}}, NIT {{inmobiliaria.nit}}, Matrícula de Arrendador No. {{inmobiliaria.matricula_arrendador}} expedida por {{inmobiliaria.matricula_expedida_por}} el {{inmobiliaria.matricula_fecha}}, representada legalmente por {{inmobiliaria.representante_legal}}. Domicilio: {{inmobiliaria.direccion}}.</td></tr>
  <tr><td class="k">Arrendatario</td><td>Nombre: {{arrendatario.nombre_completo}} · C.C.: {{arrendatario.cedula}} · Celular: {{arrendatario.celular}} · Correo: {{arrendatario.correo}}</td></tr>
  {{#if cotitular.nombre_completo}}<tr><td class="k">Co-titular de la fianza</td><td>Nombre: {{cotitular.nombre_completo}} · C.C.: {{cotitular.cedula}} · Celular: {{cotitular.celular}} <span class="small">(Solo aplica en modalidad Cofianza Compartida)</span></td></tr>{{/if}}
  <tr><td class="k">Fiador solidario</td><td>COFIANZA S.A.S., NIT 902.038.122-7, domicilio en Itagüí, Antioquia. Representada por Sandra Milena Valderrama Ángel. Actúa como fiador solidario sin beneficio de excusión conforme a los artículos 2361 y siguientes del Código Civil colombiano.</td></tr>
  <tr><td class="k">Inmueble</td><td>Dirección: {{inmueble.direccion}} · Municipio: {{inmueble.municipio}} · Matrícula Inmobiliaria: {{inmueble.matricula_inmobiliaria}}</td></tr>
  <tr><td class="k">Destinación</td><td>Vivienda del arrendatario y su familia</td></tr>
  <tr><td class="k">Canon mensual</td><td>$ {{inmueble.canon_numero}} ({{inmueble.canon_letras}} pesos M/CTE)</td></tr>
  <tr><td class="k">Duración</td><td>{{contrato.duracion_meses}} meses</td></tr>
  <tr><td class="k">Fecha de inicio</td><td>{{contrato.fecha_inicio}}</td></tr>
  <tr><td class="k">Fecha de vencimiento</td><td>{{contrato.fecha_vencimiento}}</td></tr>
  <tr><td class="k">Servicios públicos</td><td>{{contrato.servicios_publicos_cargo}}</td></tr>
  <tr><td class="k">Administración PH</td><td>{{contrato.administracion_ph_cargo}}</td></tr>
  <tr><td class="k">Día límite de pago</td><td>Primeros {{contrato.dia_limite_pago}} días de cada periodo mensual. Mora automática desde el día siguiente.</td></tr>
  <tr><td class="k">Modalidad de fianza</td><td>Cofianza Plena / Cofianza Compartida / Cofianza Plus — Seleccionada: <strong>{{contrato.modalidad}}</strong></td></tr>
  <tr><td class="k">Cuenta para pagos</td><td>{{inmobiliaria.banco}} — {{inmobiliaria.tipo_cuenta}} No. {{inmobiliaria.numero_cuenta}} a nombre de {{inmobiliaria.razon_social}}</td></tr>
</table>

<h2>Cláusula Primera. Objeto</h2>
<p>Por medio del presente contrato, EL ARRENDADOR concede a EL ARRENDATARIO el goce del inmueble identificado en la tabla anterior, de acuerdo con el inventario suscrito por separado que hace parte integral de este contrato. EL ARRENDATARIO declara recibir el inmueble en adecuadas condiciones de uso, funcionamiento y presentación, a paz y salvo por concepto de servicios públicos y cargos asociados.</p>
<p class="par"><span class="par-label">PARÁGRAFO:</span> El inmueble está sometido a régimen de propiedad horizontal: {{inmueble.propiedad_horizontal}}. Incluye parqueadero: {{inmueble.parqueadero}}. Incluye cuarto útil: {{inmueble.cuarto_util}}. Si el inmueble incluye parqueadero, este se entrega como accesorio del inmueble principal y su uso está sujeto a las mismas condiciones del contrato. EL ARRENDATARIO no podrá ceder, subarrendar ni destinar el parqueadero a un uso diferente al estacionamiento de vehículos.</p>

<h2>Cláusula Segunda. Destinación</h2>
<p>EL ARRENDATARIO se obliga a destinar el inmueble exclusivamente para su vivienda y la de su familia, sin darle otro uso ni cederlo o subarrendarlo sin autorización escrita de EL ARRENDADOR. El incumplimiento de esta cláusula dará derecho a EL ARRENDADOR para dar por terminado el contrato y exigir la entrega del inmueble.</p>
<p class="par"><span class="par-label">PARÁGRAFO PRIMERO:</span> EL ARRENDATARIO no destinará el inmueble a fines ilícitos ni permitirá actividades contrarias a la ley, el orden público, las buenas costumbres o el reglamento de propiedad horizontal aplicable. No guardará ni permitirá que se guarden sustancias inflamables, explosivas, estupefacientes u otras que pongan en riesgo la seguridad del inmueble o del vecindario.</p>
<p class="par"><span class="par-label">PARÁGRAFO SEGUNDO:</span> LAS PARTES declaran conocer y cumplir la normatividad aplicable al inmueble según su naturaleza y destinación.</p>

<h2>Cláusula Tercera. Canon, forma de pago y ajuste anual</h2>
<p>El canon mensual de arrendamiento es el indicado en la tabla de identificación. EL ARRENDATARIO lo pagará dentro de los primeros {{contrato.dia_limite_pago}} días calendario de cada periodo mensual. A partir del día siguiente al vencimiento de dicho plazo, EL ARRENDATARIO estará en mora contractual automática sin necesidad de requerimiento previo. La tolerancia en aceptar pagos tardíos no modifica las condiciones pactadas ni invalida los efectos de la mora. La aceptación de pagos parciales no modificará las estipulaciones relativas al precio ni los efectos que la mora produzca.</p>
<p class="par"><span class="par-label">PARÁGRAFO PRIMERO — Forma de pago:</span> El pago del canon más la comisión mensual de fianza COFIANZA se realizará en un único pago mediante consignación o transferencia a la cuenta indicada en la tabla de identificación. Una vez efectuado el pago, EL ARRENDATARIO notificará a EL ARRENDADOR al WhatsApp {{inmobiliaria.whatsapp_cartera}} o al correo {{inmobiliaria.correo_cartera}}.</p>
<p class="par"><span class="par-label">PARÁGRAFO SEGUNDO — Gestión de cartera:</span> Si EL ARRENDATARIO paga el canon fuera del periodo oportuno pero antes de que COFIANZA S.A.S. active la ejecución de la fianza, deberá pagar adicionalmente el cargo por gestión de cartera correspondiente al tramo de mora vigente según la escala establecida en la Cláusula Séptima del presente contrato. Este cargo se causa de manera automática desde el día siguiente al plazo de pago establecido en este contrato, sin necesidad de requerimiento previo.</p>
<p class="par"><span class="par-label">PARÁGRAFO TERCERO — Comisión mensual de fianza COFIANZA:</span> EL ARRENDATARIO se obliga a pagar mensualmente, junto con el canon, la comisión del servicio de fianza de COFIANZA S.A.S. según la modalidad aprobada: {{contrato.comision_texto}} del canon vigente. Este valor no hace parte del canon de arrendamiento, se referencia de manera independiente en el recibo de caja y se ajusta automáticamente cada vez que el canon se incremente.</p>
<p class="par"><span class="par-label">PARÁGRAFO CUARTO — Prima de vinculación COFIANZA:</span> EL ARRENDATARIO pagó al inicio del contrato la prima de vinculación de COFIANZA S.A.S. equivalente al {{contrato.prima_texto}} del canon mensual. Este pago es único, no reembolsable bajo ninguna circunstancia —incluyendo la terminación anticipada por cualquier causa, incluso por mutuo acuerdo— y no hace parte del canon.</p>
<p class="par"><span class="par-label">PARÁGRAFO QUINTO — Ajuste anual del canon:</span> Vencido el primer año y cada doce (12) mensualidades siguientes, el canon se incrementará automáticamente en un porcentaje igual al ciento por ciento (100%) del IPC del año calendario inmediatamente anterior, sin necesidad de requerimiento alguno. La comisión de fianza COFIANZA se ajustará en la misma proporción. Al suscribir este contrato, EL ARRENDATARIO y el CO-TITULAR quedan plenamente notificados de todos los reajustes automáticos pactados.</p>

<h2>Cláusula Cuarta. Vigencia y prórrogas</h2>
<p>La duración del contrato es la indicada en la tabla de identificación, contada a partir de la fecha de inicio allí señalada. El canon correspondiente a los días del mes en curso anteriores al inicio formal se cancelará de manera proporcional hasta el último día de dicho mes.</p>
<p class="par"><span class="par-label">PARÁGRAFO PRIMERO — Prórrogas:</span> Este contrato se entenderá prorrogado en iguales condiciones y por el mismo término inicial, siempre que cada una de las partes haya cumplido con las obligaciones a su cargo y EL ARRENDATARIO se avenga a los reajustes de renta pactados conforme a la Ley 820 de 2003.</p>

<h2>Cláusula Quinta. Servicios públicos y administración</h2>
<p>Los siguientes servicios y cargos se distribuyen entre las partes de acuerdo a lo pactado. Los impuestos prediales y valorizaciones estarán siempre a cargo de EL ARRENDADOR.</p>
<table>
  <tr><th>Concepto</th><th>Arrendatario</th><th>Arrendador</th></tr>
  <tr><td>Agua y alcantarillado</td><td>{{serv.agua.arrendatario}}</td><td>{{serv.agua.arrendador}}</td></tr>
  <tr><td>Energía eléctrica</td><td>{{serv.energia.arrendatario}}</td><td>{{serv.energia.arrendador}}</td></tr>
  <tr><td>Gas natural</td><td>{{serv.gas.arrendatario}}</td><td>{{serv.gas.arrendador}}</td></tr>
  <tr><td>Recolección de basuras</td><td>{{serv.basuras.arrendatario}}</td><td>{{serv.basuras.arrendador}}</td></tr>
  <tr><td>Alumbrado público</td><td>{{serv.alumbrado.arrendatario}}</td><td>{{serv.alumbrado.arrendador}}</td></tr>
  <tr><td>Internet / TV / Telefonía</td><td>{{serv.internet.arrendatario}}</td><td>{{serv.internet.arrendador}}</td></tr>
  <tr><td>Administración propiedad horizontal</td><td>{{serv.admin_ph.arrendatario}}</td><td>{{serv.admin_ph.arrendador}}</td></tr>
  <tr><td>Impuesto predial y valorizaciones</td><td>—</td><td>Siempre Arrendador</td></tr>
</table>
<p class="par"><span class="par-label">PARÁGRAFO PRIMERO:</span> EL ARRENDATARIO deberá presentar comprobantes de pago de servicios cuando EL ARRENDADOR lo requiera, y será responsable de multas, sanciones y recargos causados durante su tenencia.</p>
<p class="par"><span class="par-label">PARÁGRAFO SEGUNDO:</span> EL ARRENDATARIO deberá entregar con mínimo cinco (5) días de antelación a la fecha de restitución del inmueble los últimos comprobantes de pago debidamente cancelados, y pagar los valores de servicios causados y aún no facturados. Para su determinación se tomarán como referencia los montos facturados en los dos (2) últimos periodos, sin perjuicio de los ajustes que resulten de la facturación definitiva.</p>
<p class="par"><span class="par-label">PARÁGRAFO TERCERO:</span> Si la administración del edificio impone multas o sanciones por comportamientos contrarios al manual de convivencia imputables a EL ARRENDATARIO, sus residentes o invitados, EL ARRENDATARIO deberá cancelarlas en un término no mayor a veinte (20) días calendario desde la notificación. El incumplimiento de esta obligación constituirá grave incumplimiento contractual y causal de terminación anticipada del contrato.</p>

<h2>Cláusula Sexta. Fianza COFIANZA S.A.S. — Fiador solidario sin beneficio de excusión</h2>
<p>COFIANZA S.A.S., identificada con NIT 902.038.122-7, suscribe el presente contrato en calidad de fiador solidario sin beneficio de excusión, con expresa renuncia al beneficio de excusión consagrado en el artículo 2383 del Código Civil colombiano, en los términos de los artículos 2361 y siguientes del mismo código. En consecuencia, EL ARRENDADOR podrá exigirle a COFIANZA S.A.S. el cumplimiento de las obligaciones de pago del canon de manera directa e inmediata, sin necesidad de agotar previamente acciones contra EL ARRENDATARIO.</p>
<p class="par"><span class="par-label">PARÁGRAFO PRIMERO — Alcance de la cobertura:</span> La fianza de COFIANZA S.A.S. cubre los siguientes conceptos dentro del periodo de vigencia del contrato y hasta el límite establecido en la modalidad de fianza aprobada según el Certificado de Riesgo COFIANZA (CRC):</p>
<table>
  <tr><th>Concepto</th><th>Cubierto por la fianza</th></tr>
  <tr><td>Cánones de arrendamiento impagos</td><td>{{cob.canones}}</td></tr>
  <tr><td>Servicios públicos domiciliarios impagos</td><td>{{cob.servicios}}</td></tr>
  <tr><td>Cuotas de administración de propiedad horizontal</td><td>{{cob.admin_ph}}</td></tr>
  <tr><td>Daños al inmueble imputables al arrendatario</td><td>{{cob.danos}}</td></tr>
  <tr><td>Cláusula penal por incumplimiento</td><td>{{cob.penal}}</td></tr>
</table>
<p>Los conceptos no marcados como cubiertos en la tabla anterior NO están incluidos en la fianza. COFIANZA S.A.S. no responderá por obligaciones que no hayan sido expresamente pactadas. Cualquier ampliación de cobertura deberá constar en el CRC correspondiente.</p>
<p class="par"><span class="par-label">PARÁGRAFO SEGUNDO — Vigencia de la fianza y efectos del incumplimiento en el pago de la comisión:</span> La fianza de COFIANZA S.A.S. permanecerá vigente durante toda la vigencia del contrato de arrendamiento y sus prórrogas, conforme a la modalidad aprobada en el Certificado de Riesgo COFIANZA (CRC). El incumplimiento por parte de EL ARRENDATARIO en el pago de la comisión mensual de fianza no afectará, suspenderá ni extinguirá automáticamente la cobertura frente a EL ARRENDADOR respecto de los cánones de arrendamiento causados durante la vigencia activa del contrato, sin perjuicio del derecho de COFIANZA S.A.S. de exigir directamente a EL ARRENDATARIO y/o sus obligados solidarios el pago de las comisiones adeudadas, intereses, gastos de cobranza y demás sumas a que haya lugar.</p>
<p class="par"><span class="par-label">PARÁGRAFO TERCERO — Firma electrónica de COFIANZA:</span> COFIANZA S.A.S. suscribe el presente contrato mediante firma electrónica institucional con sello digital, conforme a la Ley 527 de 1999, el Decreto 2364 de 2012 y la Ley 2213 de 2022. Dicha firma tiene plena validez legal y produce los mismos efectos jurídicos que la firma manuscrita del representante legal.</p>
<p class="par"><span class="par-label">PARÁGRAFO CUARTO — Subrogación:</span> Una vez COFIANZA S.A.S. pague a EL ARRENDADOR el canon garantizado, se subroga por ministerio de la ley en todos los derechos del acreedor contra EL ARRENDATARIO, conforme al artículo 1668 del Código Civil. EL ARRENDATARIO quedará obligado directamente con COFIANZA S.A.S. por el valor pagado, los intereses de mora causados desde el día de vencimiento original y los cargos por gestión de recaudo acumulados.</p>

<h2>Cláusula Séptima. Protocolo de cobro — mora y activación de la fianza</h2>
<p>Para todos los efectos de esta cláusula y de la tabla de cargos por gestión de recaudo, los días se cuentan como días calendario de mora, contados a partir del día siguiente al vencimiento del plazo de pago establecido en la Cláusula Tercera. La responsabilidad del cobro corresponde a EL ARRENDADOR durante los primeros cinco (5) días de mora. A partir del sexto (6.º) día de mora, previo reporte oportuno de EL ARRENDADOR a COFIANZA S.A.S., el cobro es responsabilidad exclusiva de COFIANZA S.A.S. conforme al protocolo detallado en el Anexo de Protocolo de Cobro que hace parte integral del presente contrato.</p>
<p><strong>Tabla de cargos por gestión de recaudo:</strong></p>
<table>
  <tr><th>Tramo de mora</th><th>Cargo sobre canon</th><th>Naturaleza jurídica</th></tr>
  <tr><td>Día 6 al 19</td><td>10%</td><td>Gestión preventiva — penalidad contractual</td></tr>
  <tr><td>Día 20 al 29</td><td>15%</td><td>Recobro post-pago al propietario</td></tr>
  <tr><td>Día 30 al 59</td><td>20%</td><td>Proceso ejecutivo en curso</td></tr>
  <tr><td>Desde día 60</td><td>25%</td><td>Restitución y proceso judicial</td></tr>
</table>
<p class="par"><span class="par-label">PARÁGRAFO:</span> Las partes declaran que los cargos por gestión de recaudo establecidos en la tabla anterior corresponden a una estimación razonable de los costos reales de gestión de cobranza y no constituyen intereses remuneratorios ni moratorios. Su naturaleza jurídica es la de penalidad contractual por incumplimiento, pactada de conformidad con el artículo 1592 del Código Civil colombiano.</p>
<p class="par"><span class="par-label">PARÁGRAFO PRIMERO — Normalización:</span> Para que la mora quede saldada, EL ARRENDATARIO deberá pagar de manera simultánea: (i) el canon de arrendamiento adeudado; (ii) los intereses de mora causados desde el día de vencimiento a la tasa máxima legal; y (iii) el cargo por gestión de recaudo del tramo en que se encuentre. No se admiten pagos parciales que excluyan alguno de estos tres conceptos.</p>
<p class="par"><span class="par-label">PARÁGRAFO SEGUNDO — Reincidencia:</span> En una segunda mora dentro de la vigencia del contrato, EL ARRENDATARIO pierde el derecho a acuerdo de pago y el proceso escala directamente al tramo correspondiente al día 20 de mora, sin transitar el tramo de gestión preventiva. En una tercera mora, COFIANZA S.A.S. podrá ejecutar la fianza desde el sexto (6.º) día de mora, sin agotar las etapas previas del protocolo.</p>
<p class="par"><span class="par-label">PARÁGRAFO TERCERO — Prohibición de pagos directos:</span> EL ARRENDADOR no recibirá pagos directos de EL ARRENDATARIO una vez activado el protocolo, sin reportarlos a COFIANZA S.A.S. dentro de las veinticuatro (24) horas siguientes. El incumplimiento libera a COFIANZA S.A.S. de la obligación de pago por el periodo correspondiente.</p>

<h2>Cláusula Octava. Cláusula penal</h2>
<p>El incumplimiento por parte de EL ARRENDATARIO de cualquiera de las cláusulas del presente contrato, incluido el simple retardo en el pago, lo constituirá en deudor de EL ARRENDADOR por una suma equivalente a tres (3) cánones de arrendamiento del valor vigente al momento del incumplimiento, a título de pena. El pago de la pena no extingue la obligación principal. EL ARRENDADOR podrá exigir simultáneamente el pago de la pena y la indemnización de perjuicios. El presente contrato presta mérito ejecutivo suficiente para el cobro de esta pena sin requerimiento previo.</p>

<h2>Cláusula Novena. Obligaciones del arrendador</h2>
<ul>
  <li>Garantizar a EL ARRENDATARIO el uso y disfrute pacífico del inmueble durante toda la vigencia del contrato.</li>
  <li>Conservar en adecuado estado de funcionamiento los servicios públicos y usos conexos del inmueble.</li>
  <li>Realizar las reparaciones necesarias para el correcto mantenimiento del inmueble que no sean imputables a EL ARRENDATARIO, dentro de un plazo razonable que no exceda diez (10) días desde la notificación.</li>
  <li>Hacer entrega del inmueble en la fecha acordada en condiciones adecuadas de uso, seguridad y salubridad.</li>
  <li>Cumplir con todas las demás obligaciones que se deriven de la naturaleza del contrato y de la legislación aplicable.</li>
</ul>

<h2>Cláusula Décima. Obligaciones del arrendatario y co-titular</h2>
<ul>
  <li>Pagar oportunamente el canon de arrendamiento y la comisión de fianza COFIANZA dentro de los primeros {{contrato.dia_limite_pago}} días de cada periodo mensual.</li>
  <li>Mantener el inmueble en las condiciones en que fue recibido, respondiendo por su adecuada conservación, salvo el deterioro normal derivado de un uso correcto.</li>
  <li>Asumir responsabilidad por los actos propios y de las personas que hagan uso del inmueble bajo su autorización.</li>
  <li>Acatar el reglamento de propiedad horizontal cuando aplique, así como el Código Nacional de Policía.</li>
  <li>Informar oportunamente a EL ARRENDADOR sobre cualquier novedad que afecte el inmueble.</li>
  <li>Restituir el inmueble al finalizar el contrato en las condiciones pactadas.</li>
  <li>No ceder ni subarrendar sin autorización previa y escrita de EL ARRENDADOR.</li>
  <li>Presentar comprobantes de pago de servicios públicos cuando EL ARRENDADOR lo requiera.</li>
  <li>Permitir las visitas de inspección con previo aviso de cinco (5) días en días y horarios hábiles.</li>
</ul>
<p class="par"><span class="par-label">PARÁGRAFO:</span> EL CO-TITULAR DE LA FIANZA se obliga de manera solidaria e indivisible frente a COFIANZA S.A.S. por todas las obligaciones derivadas del servicio de fianza, incluyendo la comisión mensual, los intereses de mora y los cargos por gestión de recaudo. COFIANZA S.A.S. podrá exigir el cumplimiento indistintamente a EL ARRENDATARIO o al CO-TITULAR.</p>

<h2>Cláusula Décima Primera. Actualización de datos y autorización de notificaciones electrónicas</h2>
<p>EL ARRENDATARIO y el CO-TITULAR se obligan a informar por escrito a EL ARRENDADOR y a COFIANZA S.A.S. cualquier cambio de dirección física, número de celular, correo electrónico o demás datos de contacto, dentro de los cinco (5) días calendario siguientes a la ocurrencia de la modificación.</p>
<p>Para todos los efectos contractuales, administrativos, prejurídicos, jurídicos y probatorios derivados del presente contrato, las partes autorizan expresa, previa e inequívocamente el uso de medios electrónicos y mensajes de datos como mecanismo válido de comunicación, gestión documental, requerimientos, avisos, notificaciones, constitución en mora, envío de estados de cuenta, comunicaciones de cobranza, citaciones, terminaciones, reclamaciones, acuerdos, certificaciones y cualquier otra actuación relacionada con la ejecución, interpretación, modificación, terminación o exigibilidad del presente contrato, de conformidad con la Ley 527 de 1999, el Código General del Proceso y demás normas concordantes.</p>
<p>En consecuencia, las comunicaciones remitidas por EL ARRENDADOR o por COFIANZA S.A.S. a las direcciones electrónicas, números celulares, aplicaciones de mensajería, correos electrónicos o demás canales digitales suministrados por EL ARRENDATARIO y el CO-TITULAR, ya sea en este contrato o mediante actualización posterior, se presumirán válidamente enviadas y recibidas, produciendo plenos efectos legales y probatorios, aun cuando el destinatario no acceda, consulte o reciba materialmente la comunicación por causas imputables a su omisión, desactualización de datos, bloqueo, saturación, pérdida de acceso, cambio de dispositivo, cancelación del servicio o cualquier situación bajo su esfera de control.</p>

<h2>Cláusula Décima Segunda. Cobro extrajudicial y honorarios</h2>
<p>En caso de incumplimiento que dé lugar a gestiones de cobro extrajudicial o judicial, EL ARRENDATARIO y el CO-TITULAR asumirán los costos, gastos y honorarios ocasionados. El presente contrato junto con el pagaré suscrito a favor de COFIANZA S.A.S. constituyen título ejecutivo complejo conforme al artículo 422 del Código General del Proceso.</p>

<h2>Cláusula Décima Tercera. Renuncia a requerimientos</h2>
<p>EL ARRENDATARIO y el CO-TITULAR renuncian expresamente a los requerimientos previos o constitución en mora de que tratan los artículos 1594 y 1595 del Código Civil, así como a cualquier otro que establezca norma procesal o sustancial. La mora opera de pleno derecho desde el día siguiente al vencimiento del plazo de pago pactado en la Cláusula Tercera del presente contrato.</p>

<h2>Cláusula Décima Cuarta. Preavisos para entrega</h2>
<p>EL ARRENDATARIO podrá dar por terminado unilateralmente el contrato a la fecha de vencimiento del término inicial o de sus prórrogas, siempre que dé previo aviso escrito a EL ARRENDADOR con una antelación no menor a tres (3) meses, mediante servicio postal autorizado, correo electrónico o carta firmada vía WhatsApp. La terminación unilateral en cualquier otro momento solo se aceptará previo pago de una indemnización equivalente a tres (3) cánones de arrendamiento vigentes al momento de la entrega.</p>

<h2>Cláusula Décima Quinta. Causales de terminación</h2>
<p>El contrato podrá darse por terminado en los eventos previstos en el Capítulo VII de la Ley 820 de 2003 y especialmente por:</p>
<ol type="a">
  <li>El no pago oportuno, pago parcial o fraccionado del canon de arrendamiento o de la comisión de fianza COFIANZA.</li>
  <li>La mora en el pago de servicios públicos cuando esta genere suspensión, desconexión o pérdida del servicio.</li>
  <li>El incumplimiento de cualquier obligación contractual. EL ARRENDATARIO tendrá quince (15) días hábiles para subsanar, contados desde el requerimiento escrito.</li>
  <li>La cesión del contrato, el subarriendo o el cambio de destinación sin autorización previa y escrita.</li>
  <li>La afectación reiterada de la tranquilidad de los vecinos o el uso del inmueble para actividades ilícitas.</li>
  <li>La vinculación de cualquiera de LAS PARTES a procesos por delitos de narcotráfico, terrorismo, lavado de activos o financiación del terrorismo.</li>
  <li>El incumplimiento de las declaraciones sobre origen lícito de recursos contenidas en la Cláusula Décima Octava.</li>
</ol>
<p class="par"><span class="par-label">PARÁGRAFO PRIMERO — Terminación por mutuo acuerdo:</span> El contrato podrá darse por terminado en cualquier momento por acuerdo escrito entre LAS PARTES, previa liquidación de todas las obligaciones pendientes.</p>
<p class="par"><span class="par-label">PARÁGRAFO SEGUNDO — Terminación unilateral:</span> Cualquiera de LAS PARTES podrá terminar unilateralmente conforme a la Ley 820 de 2003, respetando el preaviso y la indemnización legal.</p>

<h2>Cláusula Décima Sexta. Devolución satisfactoria del inmueble</h2>
<p>A la terminación del contrato por cualquier causa, EL ARRENDATARIO restituirá el inmueble a más tardar el último día del periodo pactado, en las mismas condiciones en que fue recibido conforme al inventario, a paz y salvo por cánones, administración, servicios públicos y demás obligaciones. Se levantará acta de entrega.</p>
<p class="par"><span class="par-label">PARÁGRAFO:</span> La falta de suscripción del inventario dentro de los cinco (5) días siguientes a la entrega del inmueble NO libera a EL ARRENDATARIO de la obligación de restituir el inmueble en condiciones de uso adecuado. En caso de controversia sobre el estado del inmueble, prevalecerá la descripción contenida en el acta de entrega inicial o, en su defecto, el estado reportado en la última inspección periódica realizada por EL ARRENDADOR.</p>

<h2>Cláusula Décima Séptima. Abandono del inmueble</h2>
<p>Se entenderá configurado el abandono del inmueble cuando concurran hechos objetivos, verificables y concordantes que razonablemente permitan concluir que EL ARRENDATARIO ha cesado definitivamente su ocupación, uso y custodia, tales como, entre otros: desocupación visible del inmueble, retiro sustancial de bienes personales, suspensión o ausencia de consumo de servicios, imposibilidad reiterada de contacto, manifestaciones de portería o vecinos, devolución informal de llaves, mora contractual concurrente o cualquier otro indicio equivalente.</p>
<p>Cuando existan elementos razonables que indiquen abandono por un periodo continuo superior a veinte (20) días calendario, EL ARRENDADOR podrá realizar verificación del estado del inmueble mediante visita documentada, dejando constancia fotográfica, audiovisual o escrita, con presencia de dos (2) testigos o autoridad competente cuando resulte procedente.</p>
<p>Si de dicha verificación se concluye razonablemente el abandono material del inmueble, EL ARRENDADOR podrá recuperar su tenencia, elaborar inventario de bienes hallados y notificar inmediatamente a EL ARRENDATARIO y al CO-TITULAR por los canales autorizados en este contrato. El abandono constituirá causal de terminación del contrato.</p>

<h2>Cláusula Décima Octava. Origen de ingresos y cumplimiento normativo</h2>
<p>LAS PARTES declaran bajo la gravedad del juramento que los recursos utilizados para el cumplimiento de este contrato provienen exclusivamente de actividades lícitas, que no se encuentran registradas en listas restrictivas o de prevención de lavado de activos y financiación del terrorismo nacionales o internacionales, incluyendo las listas SDN/SDT de la OFAC, SDGT bajo la Orden Ejecutiva 13224, y listas de organizaciones terroristas del Departamento de Estado de los Estados Unidos.</p>

<h2>Cláusula Décima Novena. Mejoras</h2>
<p>Las reparaciones locativas derivadas del uso ordinario son de exclusiva responsabilidad de EL ARRENDATARIO. Las reparaciones necesarias no imputables a EL ARRENDATARIO corresponden a EL ARRENDADOR, quien deberá ejecutarlas en un plazo que no exceda diez (10) días. Cualquier mejora, adecuación o modificación requiere autorización previa, expresa y escrita de EL ARRENDADOR.</p>
<p class="par"><span class="par-label">PARÁGRAFO:</span> Las mejoras no autorizadas no generan derecho a compensación. EL ARRENDATARIO podrá retirarlas siempre que no cause daño al inmueble; en caso contrario quedarán en beneficio de EL ARRENDADOR sin reconocimiento económico.</p>

<h2>Cláusula Vigésima. Cesión de derechos</h2>
<p>EL ARRENDATARIO no podrá ceder ni subarrendar el inmueble sin autorización previa, expresa y escrita de EL ARRENDADOR. LAS PARTES aceptan expresamente cualquier cesión que EL ARRENDADOR realice del contrato; la notificación se entenderá válida con el envío de la nota de cesión al correo electrónico o WhatsApp registrado.</p>

<h2>Cláusula Vigésima Primera. Comisión inmobiliaria</h2>
<p>EL ARRENDATARIO pagará a EL ARRENDADOR un porcentaje equivalente al {{inmobiliaria.comision_porcentaje}} más IVA sobre el canon acordado, por concepto de servicios inmobiliarios de intermediación, cancelado una única vez al inicio del contrato de arrendamiento.</p>

<h2>Cláusula Vigésima Segunda. Imputación del pago</h2>
<p>Todo pago efectuado por EL ARRENDATARIO se imputará conforme al siguiente orden:</p>
<ol>
  <li>Sumas pagadas por COFIANZA S.A.S. a EL ARRENDADOR por concepto de cánones garantizados (recobro por subrogación).</li>
  <li>Cargos por gestión de recaudo de COFIANZA S.A.S.</li>
  <li>Gastos y costos de cobranza extrajudicial y/o judicial.</li>
  <li>Intereses moratorios causados.</li>
  <li>Cánones de arrendamiento adeudados.</li>
  <li>Cuotas de administración vencidas.</li>
  <li>Valores correspondientes a servicios públicos.</li>
  <li>Daños, faltantes o deterioros ocasionados al inmueble.</li>
  <li>Cláusula penal pactada.</li>
  <li>Obligaciones no vencidas.</li>
</ol>

<h2>Cláusula Vigésima Tercera. Autorización para reportar a centrales de riesgo</h2>
<p>EL ARRENDATARIO y el CO-TITULAR autorizan de manera previa, expresa, informada e inequívoca la transferencia y el tratamiento de sus datos personales a favor de EL ARRENDADOR y COFIANZA S.A.S. (NIT 902.038.122), para consultar, reportar y divulgar su información crediticia ante TRANSUNION, DATACRÉDITO EXPERIAN, LONJA DE PROPIEDAD RAÍZ y demás operadores de información, conforme a la Ley 1266 de 2008. Esta autorización se extiende durante la vigencia del contrato y hasta la extinción total de las obligaciones.</p>

<h2>Cláusula Vigésima Cuarta. Tratamiento de datos personales</h2>
<p>EL ARRENDATARIO y el CO-TITULAR autorizan a {{inmobiliaria.razon_social}} (NIT {{inmobiliaria.nit}}) y a COFIANZA S.A.S. (NIT 902.038.122) para recolectar, almacenar, usar, actualizar y tratar sus datos personales, con el fin de dar cumplimiento al contrato de arrendamiento y al servicio de fianza, realizar gestiones de cobro, enviar notificaciones y ofrecer servicios adicionales. Esta autorización se otorga durante la vigencia del contrato y hasta cinco (5) años después de su terminación, conforme a la Ley 1581 de 2012.</p>

<h2>Cláusula Vigésima Quinta. Compra del inmueble arrendado</h2>
<p>Si EL ARRENDATARIO manifiesta interés en adquirir el inmueble, deberá adelantar todas las gestiones a través de EL ARRENDADOR como intermediario.</p>

<h2>Cláusula Vigésima Sexta. Mérito ejecutivo</h2>
<p>El presente contrato, junto con el pagaré en blanco con carta de instrucciones suscrito por EL ARRENDATARIO y el CO-TITULAR a favor de COFIANZA S.A.S., constituyen título ejecutivo complejo para exigir el cumplimiento de todas las obligaciones aquí contenidas, conforme al artículo 422 del Código General del Proceso.</p>

<h2>Cláusula Vigésima Séptima. Notificaciones y domicilio contractual</h2>
<table class="ident">
  <tr><td class="k">Arrendador</td><td>{{inmobiliaria.razon_social}} │ {{inmobiliaria.direccion}} │ {{inmobiliaria.correo}} │ Tel: {{inmobiliaria.telefono}}</td></tr>
  <tr><td class="k">Arrendatario</td><td>Dirección: {{arrendatario.direccion_notificacion}} · Municipio: {{arrendatario.municipio_notificacion}} · Correo: {{arrendatario.correo}} · Celular: {{arrendatario.celular}}</td></tr>
  {{#if cotitular.nombre_completo}}<tr><td class="k">Co-titular</td><td>Dirección: {{cotitular.direccion_notificacion}} · Municipio: {{cotitular.municipio_notificacion}} · Correo: {{cotitular.correo}} · Celular: {{cotitular.celular}}</td></tr>{{/if}}
  <tr><td class="k">COFIANZA S.A.S.</td><td>hola@cofianza.co │ www.cofianza.co │ Itagüí, Antioquia</td></tr>
</table>
<p class="par"><span class="par-label">PARÁGRAFO:</span> Para todos los efectos judiciales y extrajudiciales, las partes fijan como domicilio contractual el municipio de {{contrato.domicilio_contractual}}. Las notificaciones electrónicas se entenderán válidas en la fecha y hora que conste en el sistema utilizado para su envío.</p>

<h2>Cláusula Vigésima Octava. Firma y perfeccionamiento del contrato</h2>
<p>El presente contrato podrá suscribirse mediante firma electrónica o, cuando LAS PARTES así lo dispongan, mediante firma manuscrita, teniendo ambas modalidades idéntica validez y efectos jurídicos. Cuando la suscripción se realice por medios electrónicos, se sujetará a la Ley 527 de 1999, el Decreto 2364 de 2012 y la Ley 2213 de 2022. LAS PARTES declaran, conocen, entienden y aceptan que:</p>
<ol type="a">
  <li>La firma electrónica utilizada cumple con los requisitos de la Ley 527 de 1999 y el Decreto 2364 de 2012, y emplea mecanismos técnicos de identificación personal seguros y confiables para garantizar la autenticidad e integridad del documento.</li>
  <li>La firma electrónica tiene la misma validez y efectos jurídicos que la firma manuscrita para todos los efectos legales, contractuales y procesales, en aplicación del principio de equivalencia funcional consagrado en la Ley 527 de 1999.</li>
  <li>Conforme al Artículo 244 del Código General del Proceso, este documento suscrito mediante firma electrónica es auténtico y original, sin que haya lugar a repudio ni tacha de falsedad.</li>
  <li>LAS PARTES se obligan a mantener bajo su exclusivo control los medios de creación de firma y las claves de acceso asociadas al proceso de firma electrónica. Cualquier uso no autorizado será responsabilidad exclusiva de la parte titular.</li>
  <li>El contrato podrá perfeccionarse aunque LAS PARTES lo suscriban en momentos distintos, en ejemplares separados o por modalidades distintas —electrónica o manuscrita—; la concurrencia de las firmas de todas LAS PARTES, por cualquiera de dichos medios, perfecciona el contrato con plenos efectos. Cuando una de LAS PARTES firme de manera manuscrita, las disposiciones de esta cláusula y de su parágrafo relativas a la evidencia electrónica no le serán aplicables, sin que ello afecte la validez ni la exigibilidad del contrato.</li>
</ol>
<p class="par"><span class="par-label">PARÁGRAFO:</span> El registro de las direcciones IP, los metadatos de tiempo, el correo electrónico y el número de celular utilizados en el proceso de firma electrónica constituyen evidencia digital admisible conforme a la Ley 527 de 1999 y podrán ser utilizados como prueba en cualquier proceso judicial o extrajudicial. LAS PARTES renuncian a controvertir la autenticidad del documento por el solo hecho de haber sido suscrito electrónicamente.</p>

<h2>Cláusula Vigésima Novena. Integralidad del acuerdo</h2>
<p>El presente contrato constituye el acuerdo completo entre LAS PARTES sobre su objeto y reemplaza cualquier acuerdo verbal o escrito previo. Los documentos que forman parte integral de este contrato son: el inventario del inmueble suscrito por separado, el Certificado de Riesgo COFIANZA (CRC) correspondiente al arrendatario, el pagaré en blanco con carta de instrucciones suscrito a favor de COFIANZA S.A.S., el Anexo de Protocolo de Cobro, y el Reglamento de Fianza COFIANZA vigente al momento de la suscripción.</p>

<h2>Firmas</h2>
<p>En señal de conformidad con todo lo anterior, las partes suscriben el presente contrato en {{contrato.domicilio_contractual}}, a los {{contrato.fecha_firma_dia}} días del mes de {{contrato.fecha_firma_mes}} de {{contrato.fecha_firma_ano}}.</p>

<div class="firma-block">
  <div class="firma-line"></div>
  <p><strong>EL ARRENDATARIO</strong><br>Nombre: {{arrendatario.nombre_completo}}<br>C.C.: {{arrendatario.cedula}}</p>

  {{#if cotitular.nombre_completo}}
  <div class="firma-line"></div>
  <p><strong>CO-TITULAR DE LA FIANZA</strong><br>Nombre: {{cotitular.nombre_completo}}<br>C.C.: {{cotitular.cedula}}</p>
  {{/if}}

  <div class="firma-line"></div>
  <p><strong>EL ARRENDADOR</strong><br>{{inmobiliaria.razon_social}}<br>NIT: {{inmobiliaria.nit}}<br>{{inmobiliaria.representante_legal}} — Representante Legal</p>

  <div class="firma-line"></div>
  <p><strong>COFIANZA S.A.S.</strong><br>NIT: 902.038.122-7<br>Fiador Solidario sin Beneficio de Excusión<br>Sandra Milena Valderrama Ángel — Representante Legal<br><span class="small">Firma electrónica institucional — Ley 527 de 1999</span></p>
</div>

</body>
</html>$contrato$,
  $$[
    {"clave": "inmobiliaria.razon_social", "fuente": "perfiles.razon_social (FASE 2: map de arrendador)"},
    {"clave": "inmobiliaria.nit", "fuente": "perfiles.numero_documento (FASE 2)"},
    {"clave": "inmobiliaria.matricula_arrendador", "fuente": "perfiles.matricula_arrendador (ya existe)"},
    {"clave": "inmobiliaria.matricula_expedida_por", "fuente": "FASE 3 — campo nuevo"},
    {"clave": "inmobiliaria.matricula_fecha", "fuente": "FASE 3 — campo nuevo"},
    {"clave": "inmobiliaria.representante_legal", "fuente": "perfiles.representante_legal (ya existe)"},
    {"clave": "inmobiliaria.direccion", "fuente": "perfiles.domicilio_direccion (FASE 2)"},
    {"clave": "inmobiliaria.correo", "fuente": "perfiles.email (FASE 2)"},
    {"clave": "inmobiliaria.telefono", "fuente": "perfiles.telefono (FASE 2)"},
    {"clave": "inmobiliaria.banco", "fuente": "perfiles.cuenta_recaudo_banco (ya existe)"},
    {"clave": "inmobiliaria.tipo_cuenta", "fuente": "perfiles.cuenta_recaudo_tipo (ya existe)"},
    {"clave": "inmobiliaria.numero_cuenta", "fuente": "perfiles.cuenta_recaudo_numero (ya existe)"},
    {"clave": "inmobiliaria.whatsapp_cartera", "fuente": "perfiles.whatsapp_recaudo (ya existe)"},
    {"clave": "inmobiliaria.correo_cartera", "fuente": "perfiles.email_recaudo (ya existe)"},
    {"clave": "inmobiliaria.comision_porcentaje", "fuente": "config comision_intermediacion_porcentaje (FASE 2)"},
    {"clave": "inmobiliaria.logo_url", "fuente": "perfiles.logo_url (ya existe)"},
    {"clave": "arrendatario.nombre_completo", "fuente": "solicitantes.nombre + apellido (FASE 2)"},
    {"clave": "arrendatario.cedula", "fuente": "solicitantes.numero_documento (FASE 2)"},
    {"clave": "arrendatario.celular", "fuente": "solicitantes.telefono (FASE 2)"},
    {"clave": "arrendatario.correo", "fuente": "solicitantes.email (FASE 2)"},
    {"clave": "arrendatario.direccion_notificacion", "fuente": "solicitantes.direccion (FASE 2)"},
    {"clave": "arrendatario.municipio_notificacion", "fuente": "solicitantes.ciudad (FASE 2)"},
    {"clave": "cotitular.*", "fuente": "FASE 3 — co-titular de fianza (modalidad Compartida), modelo nuevo"},
    {"clave": "inmueble.direccion", "fuente": "inmuebles.direccion (FASE 2)"},
    {"clave": "inmueble.municipio", "fuente": "inmuebles.ciudad (FASE 2)"},
    {"clave": "inmueble.matricula_inmobiliaria", "fuente": "inmuebles.matricula_inmobiliaria (FASE 2/3)"},
    {"clave": "inmueble.canon_numero", "fuente": "inmuebles.canon (FASE 2)"},
    {"clave": "inmueble.canon_letras", "fuente": "FASE 3 — derivado (número a letras)"},
    {"clave": "inmueble.propiedad_horizontal", "fuente": "inmuebles (FASE 2/3)"},
    {"clave": "inmueble.parqueadero", "fuente": "inmuebles (FASE 2/3)"},
    {"clave": "inmueble.cuarto_util", "fuente": "inmuebles (FASE 2/3)"},
    {"clave": "contrato.duracion_meses", "fuente": "contratos.duracion_meses (FASE 2)"},
    {"clave": "contrato.fecha_inicio", "fuente": "contratos.fecha_inicio (FASE 2)"},
    {"clave": "contrato.fecha_vencimiento", "fuente": "contratos — derivado (FASE 2)"},
    {"clave": "contrato.dia_limite_pago", "fuente": "config / contrato (FASE 2)"},
    {"clave": "contrato.servicios_publicos_cargo", "fuente": "FASE 3"},
    {"clave": "contrato.administracion_ph_cargo", "fuente": "FASE 3"},
    {"clave": "contrato.modalidad", "fuente": "FASE 3 — modalidad de fianza (Plena/Compartida/Plus)"},
    {"clave": "contrato.comision_texto", "fuente": "FASE 3 — por modalidad"},
    {"clave": "contrato.prima_texto", "fuente": "FASE 3 — por modalidad"},
    {"clave": "contrato.domicilio_contractual", "fuente": "FASE 2/3"},
    {"clave": "contrato.fecha_firma_dia|mes|ano", "fuente": "FASE 2 — al firmar"},
    {"clave": "serv.*", "fuente": "FASE 3 — reparto de servicios por contrato"},
    {"clave": "cob.*", "fuente": "FASE 3 — cobertura según CRC/modalidad"}
  ]$$::jsonb,
  false
);
