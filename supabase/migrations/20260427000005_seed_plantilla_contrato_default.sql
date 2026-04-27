-- ============================================================
-- Seed: plantilla activa por defecto del contrato de arrendamiento.
--
-- Convertida desde el documento del cliente (CONTRATO AT VIVIENDA.docx)
-- a HTML con placeholders {{variable}} y bloques {{#if cond}}…{{/if}}.
-- Datos hardcoded de Habitar/Cofianza/CONSTRUCTORA Y ARRENDAMIENTOS DE
-- ANTIOQUIA SAS reemplazados por variables que se resuelven al generar
-- el PDF segun el inmueble y su gestor (inmobiliaria | propietario).
--
-- Variables esperadas (resolver desde inmueble + expediente + perfil
-- arrendador + configuracion_sistema):
--
--   arrendador.razon_social, .tipo_documento_label, .numero_documento,
--             .representante_legal, .domicilio_direccion,
--             .domicilio_ciudad, .matricula_arrendador, .logo_url,
--             .es_inmobiliaria, .whatsapp_recaudo, .email_recaudo,
--             .cuenta_banco, .cuenta_tipo, .cuenta_numero,
--             .cuenta_titular_nombre, .cuenta_titular_nit
--   arrendatario.nombre_completo, .numero_documento, .direccion,
--                .ciudad, .email, .celular
--   coarrendatario (opcional, mismas claves que arrendatario)
--   inmueble.direccion, .ciudad, .ubicacion_detallada,
--           .es_propiedad_horizontal, .tiene_parqueadero,
--           .tiene_cuarto_util
--   contrato.fecha_dia, .fecha_dia_letras, .fecha_mes_nombre,
--            .fecha_anio, .duracion_meses, .duracion_meses_letras,
--            .fecha_inicio_completa, .fecha_fin_completa
--   canon.valor_numerico, .valor_letras
--   config.afianzamiento_mensual, .afianzamiento_mensual_letras,
--          .comision_porcentaje
-- ============================================================

INSERT INTO plantillas_contrato (nombre, descripcion, contenido_html, variables, activa)
VALUES (
  'Contrato de arrendamiento vivienda — V1',
  'Plantilla unica para contratos de arrendamiento de vivienda. Inyecta logo + datos de la inmobiliaria cuando el inmueble es gestionado por una; en propietario directo se omite el logo y la clausula de comision.',
  $contrato$<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<style>
  @page { size: Letter; margin: 2cm; }
  body { font-family: "Times New Roman", serif; font-size: 11pt; line-height: 1.4; color: #111; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 18px; }
  .header .titulo-wrap { flex: 1; text-align: center; }
  .header .logo { width: 110px; max-height: 90px; object-fit: contain; margin-left: 12px; }
  h1 { font-size: 13pt; font-weight: bold; text-transform: uppercase; margin: 0; }
  h2 { font-size: 12pt; font-weight: bold; margin: 18px 0 8px 0; text-transform: uppercase; text-align: center; }
  p { margin: 8px 0; text-align: justify; }
  .meta-row { margin: 4px 0; }
  .meta-label { font-weight: bold; text-transform: uppercase; }
  .clause-title { font-weight: bold; }
  ul { padding-left: 22px; margin: 6px 0; }
  ol { padding-left: 22px; margin: 6px 0; }
  .firma-block { margin-top: 36px; page-break-inside: avoid; }
  .firma-line { border-top: 1px solid #000; width: 280px; margin-top: 28px; margin-bottom: 4px; }
  .small { font-size: 9.5pt; color: #444; }
</style>
</head>
<body>

<div class="header">
  <div class="titulo-wrap">
    <h1>Contrato de arrendamiento para inmuebles con destinación vivienda</h1>
  </div>
  {{#if arrendador.logo_url}}<img src="{{arrendador.logo_url}}" class="logo" alt="Logo arrendador">{{/if}}
</div>

<p><span class="meta-label">Lugar y fecha del contrato:</span> {{arrendador.domicilio_ciudad}}, {{contrato.fecha_dia_letras}} de {{contrato.fecha_mes_nombre}} de {{contrato.fecha_anio}}</p>

<div class="meta-row"><span class="meta-label">Arrendador:</span> {{arrendador.razon_social}}{{#if arrendador.numero_documento}}, CON {{arrendador.tipo_documento_label}} {{arrendador.numero_documento}}{{/if}}{{#if arrendador.representante_legal}}, REPRESENTADA LEGALMENTE POR {{arrendador.representante_legal}}{{/if}} con domicilio en {{arrendador.domicilio_ciudad}}{{#if arrendador.matricula_arrendador}}, con Matrícula de arrendador No. {{arrendador.matricula_arrendador}}{{/if}}.</div>
<div class="meta-row"><span class="meta-label">Arrendatario:</span> {{arrendatario.nombre_completo}}</div>
{{#if coarrendatario}}<div class="meta-row"><span class="meta-label">Coarrendatario:</span> {{coarrendatario.nombre_completo}}</div>{{/if}}
<div class="meta-row"><span class="meta-label">Dirección del inmueble:</span> {{inmueble.direccion}}, {{inmueble.ciudad}}</div>
<div class="meta-row"><span class="meta-label">Duración del contrato:</span> {{contrato.duracion_meses}} ({{contrato.duracion_meses_letras}}) meses</div>
<div class="meta-row"><span class="meta-label">Fecha de iniciación:</span> {{contrato.fecha_inicio_completa}}</div>
<div class="meta-row"><span class="meta-label">Fecha de vencimiento:</span> {{contrato.fecha_fin_completa}}</div>
<div class="meta-row"><span class="meta-label">Canon arrendamiento:</span> ${{canon.valor_numerico}} ({{canon.valor_letras}})</div>

<h2>Condiciones generales</h2>

<p><span class="clause-title">PRIMERA: OBJETO DEL CONTRATO.</span> Mediante el presente contrato el arrendador concede al arrendatario el goce del inmueble que adelante se identifica por su dirección, de acuerdo con el inventario que las partes firman por separado. Inmueble que se encuentra sometido {{#if inmueble.es_propiedad_horizontal}}<u>SÍ</u>{{else}}<u>NO</u>{{/if}} a régimen de propiedad horizontal. El inmueble se arrendará para el uso de vivienda del Arrendatario y su familia.</p>

<p><span class="clause-title">SEGUNDA: UBICACIÓN DEL INMUEBLE.</span> El predio que se entregará en arrendamiento se encuentra ubicado en {{inmueble.ubicacion_detallada}}.</p>

<p><span class="clause-title">Parágrafo:</span> Usos conexos o adicionales para el inmueble arrendado: El contrato de arrendamiento comprende de: Parqueadero <u>{{#if inmueble.tiene_parqueadero}}SÍ{{else}}NO{{/if}}</u>; Cuarto útil: <u>{{#if inmueble.tiene_cuarto_util}}SÍ{{else}}NO{{/if}}</u>.</p>

<p><span class="clause-title">TERCERA: DESTINACIÓN.</span> EL ARRENDATARIO se obliga a usar el inmueble para la vivienda de él y de su familia y no podrá darle otro uso, ni ceder o transferir el contrato de arrendamiento sin la autorización escrita de EL ARRENDADOR. El incumplimiento de esta cláusula dará derecho a EL ARRENDADOR para dar por terminado el contrato y exigir la entrega del inmueble. En caso de cesión o subarriendo por parte de EL ARRENDATARIO, dará derecho a EL ARRENDADOR para celebrar un nuevo contrato de arrendamiento con los usuarios reales si este así lo desea.</p>

<p><span class="clause-title">PARÁGRAFO PRIMERO:</span> EL ARRENDATARIO no destinará el inmueble a fines ilícitos, y en consecuencia se obliga a no utilizarlo para ocultar o depositar armas, explosivos, actividades de secuestro o depósito de dineros de procedencia ilícita, artículos de contrabando o para que en él se elaboren, almacenen o vendan drogas estupefacientes o sustancias alucinógenas y afines. EL ARRENDATARIO se obliga a no guardar o permitir que se guarden en el inmueble arrendado sustancias inflamables o explosivas que pongan en peligro la seguridad del mismo, y en caso de que ocurriera dentro del inmueble enfermedad infecto-contagiosa, serán de EL ARRENDATARIO los gastos de desinfección que ordenen las autoridades sanitarias.</p>

<p><span class="clause-title">PARÁGRAFO SEGUNDO:</span> LAS PARTES declaran que al momento de la firma del presente contrato conocen y cumplen con la normatividad que recae sobre el inmueble de acuerdo con su naturaleza y destinación como el reglamento de propiedad horizontal (si aplica).</p>

<p><span class="clause-title">PARÁGRAFO TERCERO:</span> Además del inmueble identificado y descrito anteriormente tendrá el arrendatario derecho de goce sobre las siguientes cosas y usos: A lo establecido en el manual de convivencia de la copropiedad que deberá ser solicitado por el arrendatario en la respectiva administración al momento de su ingreso.</p>

<p><span class="clause-title">CUARTA: PRECIO Y FORMA DE PAGO DEL CANON.</span> ${{canon.valor_numerico}} ({{canon.valor_letras}}) mensuales, pagaderos dentro los (5) primeros días calendario de cada periodo mensual. A partir del día 6, EL ARRENDATARIO estará en mora contractual automática sin necesidad de requerimientos previos.</p>

<p>La mera tolerancia de EL ARRENDADOR en aceptar el pago del precio del arrendamiento con posterioridad al plazo previsto para tal fin, no será suficiente para modificar las previsiones que al respecto han acordado LAS PARTES. Tampoco se considerarán variadas las estipulaciones relativas al precio del arrendamiento por la recepción de pagos parciales. De conformidad con lo anterior, la aceptación de pagos parciales no invalidará los efectos que la mora produzca a cargo EL ARRENDATARIO.</p>

<p><span class="clause-title">PARÁGRAFO 1: FORMA DE PAGO.</span> EL ARRENDATARIO pagará el canon de arrendamiento a EL ARRENDADOR por mensualidades anticipadas, los días 5 (cinco) de cada mes, durante todo el tiempo que tenga el inmueble a su disposición y mientras no haga entrega material del mismo a EL ARRENDADOR; mediante consignación o transferencia a la cuenta {{arrendador.cuenta_tipo}} No. {{arrendador.cuenta_numero}} de {{arrendador.cuenta_banco}} a nombre de {{arrendador.cuenta_titular_nombre}} identificado con NIT/CC No. {{arrendador.cuenta_titular_nit}}. Una vez cancelado el canon de arrendamiento, EL ARRENDATARIO le notificará a EL ARRENDADOR a través del WhatsApp {{arrendador.whatsapp_recaudo}} y correo electrónico {{arrendador.email_recaudo}}.</p>

<p><span class="clause-title">PARÁGRAFO 2: GESTIÓN DE CARTERA.</span> En caso de que el ARRENDATARIO realice el pago del canon de arrendamiento fuera del periodo oportuno establecido en la CLÁUSULA CUARTA del presente contrato, deberá pagar a título de GESTIÓN DE CARTERA a favor del ARRENDADOR, la suma equivalente al diez por ciento (10%) del valor del canon mensual de arrendamiento, más el IVA correspondiente, por cada uno de los periodos en que incurra en dicho incumplimiento. Este valor se causará de forma automática y sin necesidad de requerimiento previo, sin perjuicio de lo dispuesto en la cláusula penal pactada en este contrato y de las demás acciones legales a que haya lugar por el incumplimiento en el pago de las obligaciones contractuales.</p>

<p><span class="clause-title">PARÁGRAFO 3: PAGO DEL SERVICIO DE AFIANZAMIENTO.</span> El ARRENDATARIO se obliga a cancelar mensualmente la suma de {{config.afianzamiento_mensual_letras}} (${{config.afianzamiento_mensual}}) por concepto del servicio de afianzamiento del inmueble objeto del presente contrato. Este valor no hace parte del canon de arrendamiento y será referenciado de manera independiente en el correspondiente recibo de caja, junto con el valor del canon mensual.</p>

<p>En caso de que el ARRENDATARIO no cancele oportunamente el valor correspondiente al servicio de afianzamiento, EL ARRENDADOR podrá aplicar el pago recibido, en primer lugar, al cubrimiento de dicho concepto y, en segundo lugar, al canon de arrendamiento. El saldo pendiente del canon de arrendamiento se considerará como valor en mora, generando para el ARRENDATARIO las consecuencias legales establecidas en el presente contrato para el incumplimiento en el pago del canon, hasta tanto se realice el pago total de las sumas adeudadas.</p>

<p><span class="clause-title">PARÁGRAFO 4: FACTURACIÓN Y RECIBOS DE CAJA.</span> Las partes acuerdan que las facturas correspondientes al canon de arrendamiento, así como los recibos de caja que se generen por el pago de cualquier concepto derivado del presente contrato, podrán ser emitidos por {{arrendador.cuenta_titular_nombre}}{{#if arrendador.cuenta_titular_nit}}, identificada con NIT {{arrendador.cuenta_titular_nit}}{{/if}}, quien actúa por cuenta del ARRENDADOR. En caso de mora o incumplimiento en el pago de las obligaciones a cargo del ARRENDATARIO, dichas facturas y/o recibos constituirán prueba documental idónea de la existencia de la obligación, y podrán ser utilizados como soporte de cobro judicial o extrajudicial, en los términos y con los requisitos previstos por la ley colombiana. El ARRENDATARIO manifiesta su aceptación expresa de los documentos aquí mencionados como medios probatorios válidos ante cualquier juez de la República de Colombia.</p>

<p><span class="clause-title">PARÁGRAFO 5: INCREMENTOS DEL PRECIO.</span> Vencido el primer año de vigencia de este contrato y así sucesivamente, cada doce (12) mensualidades, en caso de prórroga tácita o expresa, en forma automática y sin necesidad de requerimiento alguno entre las partes, el precio mensual del arrendamiento se incrementará en una proporción igual al 100% del Incremento que haya tenido el índice de precios al consumidor (IPC) en el año calendario inmediatamente anterior a aquél en que se efectúe el incremento. Al suscribir este contrato el arrendatario y los COARRENDATARIOS quedan plenamente notificados de todos los reajustes automáticos pactados en este contrato y que han de operar durante la vigencia del mismo.</p>

<p><span class="clause-title">PARÁGRAFO 6:</span> El incumplimiento, total o parcial, de cualquiera de las obligaciones asumidas por EL ARRENDATARIO, así como el simple atraso en el pago del canon mensual, constituirá causal suficiente para que EL ARRENDADOR solicite la restitución del inmueble al ARRENDATARIO y/o COARRENDATARIO, sin que sea necesario requerimiento judicial o extrajudicial alguno, conforme a lo previsto en los artículos 2007 y 2034 del Código Civil y 384 del Código General del Proceso (Ley 1564 de 2012), a los cuales EL ARRENDATARIO renuncia expresamente.</p>

<p><span class="clause-title">QUINTA: VIGENCIA DEL CONTRATO.</span> {{contrato.duracion_meses_letras}} ({{contrato.duracion_meses}}) meses, que comienzan a contarse a partir del {{contrato.fecha_inicio_completa}}. El canon correspondiente a los días del mes en curso anteriores al inicio formal del período contractual será cancelado de manera proporcional hasta el último día de dicho mes, contado a partir de la cancelación efectiva de la preliquidación de ingreso ante la inmobiliaria.</p>

<p><span class="clause-title">PARÁGRAFO 1: PRÓRROGAS.</span> Este contrato se entenderá prorrogado en iguales condiciones y por el mismo término inicial, siempre que cada una de las partes haya cumplido con las obligaciones a su cargo y, que el arrendatario, se avenga a los reajustes de la renta pactados en la condición quinta y autorizados en la ley 820 de 2003.</p>

<p><span class="clause-title">SEXTA: SERVICIOS.</span> Estarán a cargo del arrendatario los servicios públicos domiciliarios (Agua, Alcantarillado, Energía, Gas, Recolección de basuras, Alumbrado Público). El arrendador no será responsable por la prestación eficiente de estos servicios.</p>

<p>El ARRENDATARIO deberá presentar al ARRENDADOR, cuando este lo requiera, los comprobantes de pago de los servicios públicos debidamente cancelados. Será igualmente responsable de las multas, sanciones, recargos y costos que impongan las empresas prestadoras o las autoridades competentes durante la vigencia del contrato, por infracciones a la normativa aplicable o por el pago extemporáneo de dichos servicios, debiendo indemnizar al ARRENDADOR por los perjuicios ocasionados.</p>

<p>Así mismo, el ARRENDATARIO no podrá celebrar acuerdos de financiación ni realizar adquisiciones relacionadas con los servicios públicos sin autorización previa y expresa del ARRENDADOR. El incumplimiento de esta obligación facultará al ARRENDADOR para solicitar la restitución del inmueble y hacer efectiva la cláusula penal pactada.</p>

<p><span class="clause-title">PARÁGRAFO PRIMERO:</span> El ARRENDADOR podrá, a su discreción, efectuar los pagos necesarios para la normalización de los servicios públicos, así como cancelar las multas o sanciones que se generen. Las sumas pagadas deberán ser reembolsadas de manera inmediata por el ARRENDATARIO, quien acepta que dicho cobro pueda exigirse por la vía ejecutiva mediante la presentación del presente contrato y los comprobantes de pago correspondientes. En caso de mora, el ARRENDATARIO deberá pagar intereses moratorios sobre los valores adeudados, calculados a la tasa máxima legal vigente para créditos de libre consumo.</p>

<p><span class="clause-title">PARÁGRAFO SEGUNDO:</span> El ARRENDATARIO deberá entregar al ARRENDADOR, o a quien este designe, con una antelación mínima de cinco (5) días a la fecha de restitución del inmueble, cualquiera sea la causa de terminación del contrato, los últimos comprobantes de pago a su cargo incluidos servicios públicos, administración y demás conceptos aplicables debidamente cancelados, así como pagar al ARRENDADOR los valores correspondientes a los servicios públicos causados y aún no facturados. Para la determinación de dichos valores se tomarán como referencia los montos facturados en los dos (2) últimos períodos, sin perjuicio de los ajustes posteriores que resulten de la facturación definitiva. El presente documento, junto con los recibos cancelados por el arrendador, constituye título ejecutivo para cobrar judicialmente al arrendatario y sus garantes los servicios que dejaren de pagar siempre que tales montos correspondan al período en el que estos tuvieron en su poder el inmueble.</p>

<p><span class="clause-title">SÉPTIMA: RECIBO Y ESTADO.</span> EL ARRENDATARIO manifiesta haber recibido el inmueble objeto del presente contrato en adecuadas condiciones de uso, funcionamiento y presentación, de conformidad con el inventario suscrito por separado, el cual se entenderá aceptado con la firma de las partes y hará parte integral de este contrato, así como a paz y salvo por concepto de servicios públicos domiciliarios y demás cargos asociados. En consecuencia, se obliga a cuidarlo, conservarlo y mantenerlo en las mismas condiciones en que lo recibió.</p>

<p>Salvo las mejoras previamente autorizadas y el deterioro normal derivado de un uso adecuado conforme a la destinación pactada, EL ARRENDATARIO será responsable por los daños ocasionados por mal uso, negligencia o descuido durante su tenencia. En caso de que, al momento de la restitución, EL ARRENDATARIO no realice las reparaciones necesarias para restituir el inmueble a su estado original, EL ARRENDADOR podrá ejecutarlas por cuenta de aquel y exigir su pago por la vía ejecutiva, mediante la presentación del presente contrato y las facturas correspondientes, las cuales constituirán título ejecutivo complejo.</p>

<p><span class="clause-title">PARÁGRAFO 1:</span> El inmueble se entrega en buen estado y deberá ser restituido al finalizar el contrato en iguales condiciones, incluyendo pintura similar a la original y sin daños, deterioros o averías en paredes, instalaciones y demás elementos del inmueble.</p>

<p><span class="clause-title">OCTAVA: OBLIGACIONES DEL ARRENDADOR.</span> Con la firma del presente contrato, y sin perjuicio de las obligaciones previstas en la ley, EL ARRENDADOR asume los siguientes compromisos:</p>
<ol>
  <li>Garantizar a EL ARRENDATARIO el uso y disfrute pacífico del inmueble arrendado durante toda la vigencia del contrato, saneando oportunamente cualquier situación que afecte, restrinja o impida dicho goce, conforme a la normatividad vigente.</li>
  <li>Conservar en adecuado estado de funcionamiento los servicios públicos, usos conexos y adicionales que hagan parte del inmueble, asegurando su aptitud para el destino pactado.</li>
  <li>Realizar las reparaciones necesarias para el correcto mantenimiento del inmueble, siempre que los daños no sean imputables a EL ARRENDATARIO, quien deberá informar oportunamente sobre la necesidad de dichas reparaciones. En caso de que EL ARRENDADOR no las ejecute dentro de un plazo razonable, EL ARRENDATARIO podrá efectuarlas y tendrá derecho al reembolso de los gastos correspondientes.</li>
  <li>Autorizar a EL ARRENDATARIO para efectuar las mejoras, adecuaciones o modificaciones requeridas para el uso previsto del inmueble, siempre que estas no generen menoscabo o afectación patrimonial al bien arrendado.</li>
  <li>Hacer entrega del inmueble en la fecha acordada, en condiciones adecuadas de uso, seguridad y salubridad, junto con los servicios públicos y demás elementos convenidos. La entrega se entenderá cumplida con la suscripción del inventario correspondiente, en el cual constarán las condiciones del inmueble y los bienes que lo integran, el cual será firmado por las partes y formará parte integral del presente contrato.</li>
  <li>Cumplir con todas las demás obligaciones que se deriven de la naturaleza del contrato de arrendamiento y de la legislación aplicable.</li>
</ol>

<p><span class="clause-title">NOVENA: OBLIGACIONES DEL ARRENDATARIO Y COARRENDATARIO.</span> Sin perjuicio de las obligaciones establecidas en la ley, EL ARRENDATARIO se compromete a cumplir las siguientes obligaciones:</p>
<ol>
  <li>Mantener el inmueble en las condiciones en que le fue entregado, respondiendo por su adecuada conservación, salvo el deterioro normal derivado de un uso correcto y conforme a su destinación.</li>
  <li>Asumir responsabilidad por los actos propios y por aquellos realizados por sus familiares, dependientes, usuarios o cualquier persona que haga uso del inmueble bajo su autorización.</li>
  <li>Acatar las disposiciones del reglamento de propiedad horizontal, cuando sea aplicable, así como las normas del Código Nacional de Policía y demás disposiciones legales pertinentes.</li>
  <li>Abstenerse de constituir gravámenes, obligaciones crediticias o compromisos financieros sobre el inmueble o sobre los bienes y elementos puestos a su disposición para su uso y goce.</li>
  <li>Informar de manera oportuna a EL ARRENDADOR sobre cualquier hecho, novedad o situación relevante que pueda afectar el inmueble, su administración, los ocupantes o el normal desarrollo del contrato, incluyendo, sin limitarse a: (a) la cesión del contrato cuando proceda; (b) cualquier circunstancia relevante para el propietario o el inmueble; (c) la existencia de obligaciones pendientes por concepto de administración, servicios o cualquier otro cobro.</li>
  <li>Restituir el inmueble al finalizar el contrato, por cualquier causa, en las condiciones pactadas y en el mismo estado en que lo recibió, salvo el desgaste normal autorizado.</li>
  <li>Cumplir con las demás obligaciones que se deriven de la naturaleza del contrato de arrendamiento.</li>
</ol>

{{#if coarrendatario}}
<p><span class="clause-title">DÉCIMA: COARRENDATARIO.</span> Con el fin de garantizar el cumplimiento de todas las obligaciones a cargo de EL ARRENDATARIO, comparece como COARRENDATARIO {{coarrendatario.nombre_completo}}, mayor de edad, identificado(a) con cédula de ciudadanía No. {{coarrendatario.numero_documento}}, quien declara que se obliga de manera solidaria e indivisible frente a EL ARRENDADOR por todas las obligaciones derivadas del presente contrato, durante su vigencia, sus prórrogas y por todo el tiempo en que el inmueble permanezca en poder del ARRENDATARIO. Dicha responsabilidad comprende, sin limitarse a, el pago de cánones de arrendamiento, indemnizaciones, daños al inmueble, intereses moratorios, gastos y gestiones de cobro, honorarios profesionales derivados de cobro extrajudicial o judicial, costas procesales que se impongan en procesos de restitución, así como las cláusulas penales pactadas.</p>

<p>Las obligaciones solidarias aquí asumidas podrán ser exigidas por EL ARRENDADOR a cualquiera de los obligados, por la vía extrajudicial o ejecutiva, sin necesidad de requerimientos previos, judiciales o privados, a los cuales se renuncia expresamente. La presente solidaridad no implica, en ningún caso, que el COARRENDATARIO adquiera la calidad de fiador ni de arrendatario del inmueble, condición que corresponde exclusivamente a EL ARRENDATARIO y a sus causahabientes.</p>

<p>Sin perjuicio de lo anterior, en caso de abandono del inmueble, cualquiera de los COARRENDATARIOS podrá efectuar válidamente la entrega del mismo a EL ARRENDADOR o a quien este designe, por vía judicial o extrajudicial. Para este único efecto, EL ARRENDATARIO otorga desde ahora poder amplio y suficiente a los COARRENDATARIOS, el cual se entiende conferido con la suscripción del presente contrato.</p>

<p>EL COARRENDATARIO manifiesta haber recibido copia del presente contrato debidamente suscrito por las partes.</p>
{{/if}}

<p><span class="clause-title">DÉCIMA PRIMERA: CUOTAS DE ADMINISTRACIÓN.</span> Si el inmueble está sujeto al Régimen de Propiedad Horizontal, la cuota correspondiente a gastos y sostenimiento de administración de la unidad residencial o edificio será por cuenta del propietario del inmueble, lo mismo que los incrementos y las cuotas extras que se fijen.</p>

<p><span class="clause-title">PARÁGRAFO PRIMERO:</span> Si hubieran multas o sanciones de parte de la administración del edificio por comportamientos contrarios al manual de convivencia por el arrendatario, residente o invitados al inmueble, estos pagos deberán ser asumidos en un término no mayor a 20 días calendario después de notificada la sanción. El hecho de no cancelarlo representará un grave incumplimiento al contrato y será causal de terminación anticipada y el cobro de la cláusula penal de este contrato.</p>

<p><span class="clause-title">DÉCIMA SEGUNDA: CLÁUSULA PENAL.</span> El incumplimiento por parte del arrendatario de cualquiera de las cláusulas de este contrato, y aún el simple retardo en el pago de una o más mensualidades, lo constituirá en deudor del ARRENDADOR, por una suma equivalente a tres cánones de arrendamiento del valor que esté vigente en el momento en que tal incumplimiento se presente a título de pena. Se entenderá, en todo caso, que el pago de la pena no extingue la obligación principal y que el arrendador podrá pedir a la vez el pago de la pena y la indemnización de perjuicios, si es el caso. Este contrato será prueba sumaria suficiente para el cobro de esta pena y el arrendatario y sus COARRENDATARIO renuncian expresamente a cualquier requerimiento privado o judicial para constituirlos en mora del pago de esta o cualquier otra obligación derivada del contrato. Para efectos de su cobro por la vía ejecutiva, el presente contrato prestará mérito ejecutivo suficiente, sin que sea necesario requerimiento previo, judicial o extrajudicial.</p>

<p><span class="clause-title">DÉCIMA TERCERA: COBRO EXTRAJUDICIAL.</span> En caso de incumplimiento en el pago oportuno de los cánones de arrendamiento, servicios públicos, cuotas de administración, celaduría y/o vigilancia, o de cualquier otra obligación económica derivada del presente contrato, que dé lugar a la realización de gestiones de cobro extrajudicial, EL ARRENDATARIO y los COARRENDATARIOS asumirán y deberán pagar los costos y gastos ocasionados por dichas gestiones, incluidos los honorarios de la entidad o persona encargada del cobro.</p>

<p><span class="clause-title">DÉCIMA CUARTA: RENUNCIA A REQUERIMIENTOS.</span> EL ARRENDATARIO y EL COARRENDATARIO manifiesta libre de todo apremio que renuncia a los requerimientos previos o la constitución en mora de que tratan los Artículos 1594 y 1595 del Código Civil así como a cualquier otro que establezca cualquier norma de carácter procesal o sustancial.</p>

<p><span class="clause-title">DÉCIMA QUINTA: PREAVISOS PARA LA ENTREGA.</span> El arrendatario podrá dar por terminado unilateralmente el contrato de arrendamiento a la fecha de vencimiento del término inicial o de sus prórrogas, siempre y cuando dé previo aviso escrito al arrendador a través del servicio postal autorizado, correo electrónico o carta escaneada y firmada vía whatsapp, con una antelación no menor de tres (3) meses a la referida fecha de vencimiento. La terminación unilateral por parte del arrendatario en cualquier otro momento solo se aceptará previo el pago de una indemnización equivalente al precio de tres (3) meses de arrendamiento que esté vigente en el momento de entrega del inmueble.</p>

<p><span class="clause-title">PARÁGRAFO:</span> En cualquier momento y por medios electrónicos (correo electrónico o whatsapp) al arrendatario que no le renovará o que dará por terminado unilateralmente el contrato de arrendamiento si este incurriera reiteradamente en pagos extemporáneos del canon.</p>

<p><span class="clause-title">DÉCIMA SEXTA: CAUSALES DE TERMINACIÓN.</span> LAS PARTES acuerdan que el presente contrato de arrendamiento podrá darse por terminado en los eventos previstos en el Capítulo VII de la Ley 820 de 2003 y, en especial, por las siguientes causales:</p>
<ol type="a">
  <li>El no pago oportuno, pago parcial o fraccionado del canon de arrendamiento.</li>
  <li>La mora en el pago de los servicios públicos cuando esta genere suspensión, desconexión o pérdida del servicio.</li>
  <li>El incumplimiento de cualquiera de las obligaciones contractuales o de las normas del reglamento de propiedad horizontal o reglamento interno aplicable. EL ARRENDATARIO contará con un plazo de quince (15) días hábiles, contados a partir del requerimiento escrito, para subsanar el incumplimiento; vencido dicho término sin corrección, el contrato podrá darse por terminado.</li>
  <li>La cesión del contrato, el subarriendo o el cambio de destinación del inmueble sin autorización previa, expresa y escrita de EL ARRENDADOR.</li>
  <li>La afectación reiterada de la tranquilidad de los vecinos, el uso del inmueble para actividades ilícitas o contrarias a las buenas costumbres, o aquellas que representen riesgo para la seguridad o salubridad.</li>
  <li>La ocurrencia de fuerza mayor o caso fortuito debidamente comprobados que imposibiliten la ejecución del objeto contractual.</li>
  <li>La destrucción total del inmueble, su demolición, o la necesidad de desocupación para ejecutar obras de reparación mayor o nueva construcción.</li>
  <li>La destrucción total o parcial del inmueble por parte de EL ARRENDATARIO, o la ejecución de mejoras, modificaciones o ampliaciones sin autorización del ARRENDADOR.</li>
  <li>Cuando cualquiera de LAS PARTES sea vinculada, investigada o condenada por autoridades competentes en procesos relacionados con delitos de narcotráfico, terrorismo, secuestro, lavado de activos, financiación del terrorismo o delitos conexos.</li>
</ol>

<p><span class="clause-title">PARÁGRAFO PRIMERO – TERMINACIÓN POR MUTUO ACUERDO:</span> El contrato podrá darse por terminado en cualquier momento por acuerdo escrito entre LAS PARTES, previa liquidación de todas las obligaciones pendientes.</p>

<p><span class="clause-title">PARÁGRAFO SEGUNDO – TERMINACIÓN UNILATERAL:</span> Cualquiera de LAS PARTES podrá terminar unilateralmente el contrato conforme a la Ley 820 de 2003, respetando el preaviso y la indemnización legal correspondiente. En todo caso, EL ARRENDATARIO deberá encontrarse a paz y salvo por todo concepto hasta la restitución efectiva del inmueble.</p>

<p><span class="clause-title">DÉCIMA SÉPTIMA: DEVOLUCIÓN SATISFACTORIA.</span> A la terminación del presente contrato de arrendamiento, EL ARRENDATARIO y los COARRENDATARIOS deberán restituir el inmueble a más tardar el último día del periodo pactado inicialmente o de sus prórrogas, en las mismas condiciones en que fue recibido, conforme al inventario, salvo acuerdo escrito entre LAS PARTES respecto de las mejoras autorizadas. Para tal efecto, se levantará el acta de entrega correspondiente, en la cual se dejará constancia del estado del inmueble y de la verificación del inventario.</p>

<p>La restitución deberá efectuarse con el inmueble a paz y salvo por concepto de cánones de arrendamiento, cuotas y sanciones de administración, servicios públicos y cualquier otra obligación a cargo de EL ARRENDATARIO y los COARRENDATARIOS. En caso de existir obligaciones pendientes o de no encontrarse el inmueble en las condiciones pactadas para su restitución, EL ARRENDADOR quedará facultado para iniciar las acciones legales correspondientes por incumplimiento contractual, sin que ello implique prórroga alguna del contrato.</p>

<p><span class="clause-title">PARÁGRAFO PRIMERO:</span> EL ARRENDATARIO deberá cancelar el valor de los faltantes y de los daños ocasionados a los bienes y elementos relacionados en el acta de entrega, conforme a su avalúo comercial vigente a la fecha de la restitución.</p>

<p><span class="clause-title">DÉCIMA OCTAVA: CESIÓN DE LOS DERECHOS.</span> Estipulan expresamente los contratantes que este contrato no formará parte integral de ningún establecimiento de comercio y que, por lo tanto, la enajenación del que eventualmente se establezca en el inmueble, no solo no transfiere ningún derecho de arrendamiento al adquiriente, sino que constituye causal de terminación del contrato, toda vez que el arrendatario se obliga expresamente a no ceder, a no subarrendar el inmueble, ni transferir su tenencia.</p>

<p>La ocupación del inmueble por personas distintas a las expresamente autorizadas en el presente contrato se entenderá como una cesión no consentida del arrendamiento, realizada sin la autorización previa, expresa y escrita de EL ARRENDADOR. En tal evento, EL ARRENDADOR quedará facultado para dar por terminado el contrato y adelantar de manera inmediata la restitución del inmueble, ya sea por la vía extrajudicial o a través de los mecanismos de jurisdicción de paz, sin necesidad de consentimiento previo del ARRENDATARIO ni del COARRENDATARIO.</p>

<p><span class="clause-title">PARÁGRAFO – CESIÓN DEL CONTRATO:</span> LOS ARRENDATARIOS y COARRENDATARIOS aceptan de manera expresa, desde la suscripción del presente contrato, cualquier cesión que EL ARRENDADOR realice sobre el mismo. Así mismo, manifiestan su conformidad para que, en caso de incumplimiento y para efectos de la gestión de cobro y de la notificación prevista en el artículo 1960 del Código Civil, dicha notificación se entienda válidamente realizada con el envío de la respectiva nota de cesión, acompañada de copia simple del contrato, mediante correo electrónico, carta escaneada o mensaje remitido vía WhatsApp al número telefónico o a la dirección registrada en este contrato al pie de sus firmas.</p>

<p><span class="clause-title">DÉCIMA NOVENA: MEJORAS.</span> El régimen aplicable a las reparaciones, mejoras y adecuaciones del inmueble objeto de arrendamiento se sujetará a las siguientes reglas:</p>

<p><span class="clause-title">Reparaciones locativas:</span> Serán de exclusiva responsabilidad de EL ARRENDATARIO y deberán ejecutarse de manera inmediata, sin requerir autorización previa de EL ARRENDADOR. Se consideran reparaciones locativas aquellas derivadas del uso ordinario del inmueble o causadas por culpa de EL ARRENDATARIO, sus familiares, dependientes, huéspedes o usuarios.</p>

<p><span class="clause-title">Reparaciones necesarias:</span> Las reparaciones indispensables para que el inmueble conserve su uso normal o para evitar su deterioro o pérdida estarán a cargo de EL ARRENDADOR, siempre que no se originen por culpa de EL ARRENDATARIO o de las personas por las cuales este deba responder. EL ARRENDATARIO deberá informar oportunamente y por escrito a EL ARRENDADOR sobre la ocurrencia del daño. Recibida la notificación, EL ARRENDADOR dispondrá de un plazo razonable, que no excederá de diez (10) días, para adelantar las reparaciones correspondientes.</p>

<p><span class="clause-title">PARÁGRAFO PRIMERO:</span> Cualquier mejora, adecuación o modificación que EL ARRENDATARIO pretenda realizar deberá ajustarse a criterios técnicos razonables y contar con autorización previa, expresa y escrita de EL ARRENDADOR. EL ARRENDATARIO podrá retirar las mejoras realizadas, siempre que ello sea posible sin causar daño al inmueble; en caso contrario, dichas mejoras quedarán en beneficio de EL ARRENDADOR, sin que este deba reconocer compensación alguna.</p>

<p><span class="clause-title">VIGÉSIMA: INSPECCIÓN DEL INMUEBLE.</span> EL ARRENDATARIO y los COARRENDATARIOS se obligan a permitir, en cualquier momento, las visitas de inspección que EL ARRENDADOR, directamente o por medio de sus dependientes o delegados, deban realizar para verificar el estado de uso y conservación del inmueble arrendado. Dichas visitas deberán ser previamente notificadas con una antelación mínima de cinco (5) días y efectuarse exclusivamente en días y horarios hábiles.</p>

<p><span class="clause-title">VIGÉSIMA PRIMERA: EXENCIÓN DE RESPONSABILIDAD.</span> Ninguna de las partes será responsable por pérdidas, robos o daños derivados de caso fortuito, fuerza mayor o hechos atribuibles a terceros. EL ARRENDATARIO solo responderá por los perjuicios ocasionados al inmueble o a bienes, enseres o dotaciones de vecinos o terceros, cuando dichos daños sean consecuencia directa de su culpa, negligencia o descuido, o de las personas por las cuales deba responder, tales como familiares, dependientes, huéspedes o subarrendatarios.</p>

<p><span class="clause-title">VIGÉSIMA SEGUNDA: ABANDONO DEL INMUEBLE.</span> EL ARRENDATARIO y los COARRENDATARIOS autorizan de manera expresa, previa e irrevocable a EL ARRENDADOR o a quien este designe, para ingresar al inmueble y recuperar su tenencia, con la sola presencia de dos (2) testigos, cuando el inmueble se encuentre abandonado y/o desocupado por un período continuo de diez (10) días, o cuando exista un riesgo evidente que amenace la integridad física del inmueble o la seguridad del vecindario. El abandono del inmueble constituirá, en todo caso, causal de terminación del contrato.</p>

<p>EL ARRENDADOR deberá dejar constancia escrita del estado y condiciones en que se recupera el inmueble, mediante la elaboración del acta correspondiente, y podrá solicitar, si lo estima conveniente, el acompañamiento de la autoridad policial para la realización de la diligencia. Las obligaciones económicas derivadas del contrato, incluyendo cánones de arrendamiento, servicios públicos y cuotas de administración, continuarán a cargo de EL ARRENDATARIO hasta la fecha en que EL ARRENDADOR recupere efectivamente la tenencia del inmueble, conforme a la fecha que conste en el acta de recuperación.</p>

<p>En caso de encontrarse bienes muebles o enseres dentro del inmueble al momento de la recuperación por abandono, estos quedarán bajo custodia de EL ARRENDADOR por un término máximo de dos (2) semanas. EL ARRENDADOR notificará a EL ARRENDATARIO y a los COARRENDATARIOS para que procedan a reclamarlos dentro de dicho plazo; vencido este sin que se realice el retiro, EL ARRENDADOR quedará facultado para disponer de los mismos, darlos de baja o incorporarlos a su patrimonio, sin lugar a reclamación posterior.</p>

{{#if arrendador.es_inmobiliaria}}
<p><span class="clause-title">VIGÉSIMA TERCERA: COMISIÓN.</span> El ARRENDATARIO pagará al ARRENDADOR un porcentaje equivalente al {{config.comision_porcentaje}}% más IVA, sobre el canon acordado, por concepto de servicios inmobiliarios (intermediación), el cual será cancelado una única vez al inicio del contrato de arrendamiento (Práctica comercial certificada por la Cámara de Comercio de Medellín para Antioquia).</p>
{{/if}}

<p><span class="clause-title">VIGÉSIMA CUARTA: AUTORIZACIÓN PARA REPORTAR A CENTRALES DE RIESGO.</span> EL ARRENDATARIO y el COARRENDATARIO autorizan de manera previa, expresa, informada e inequívoca la transferencia y el tratamiento de sus datos personales a favor de EL ARRENDADOR o sus delegados, con el fin de dar cumplimiento al presente contrato de arrendamiento y al contrato de fianza que lo garantice.</p>

<p>Así mismo, autorizan a EL ARRENDADOR, o a quien represente sus derechos, ostente actualmente o en el futuro la calidad de acreedor, cesionario o afianzador del contrato, para consultar, solicitar, suministrar, reportar, procesar, circular y divulgar, en cualquier tiempo y sin limitación alguna, la información relacionada con su comportamiento crediticio, financiero, comercial y de servicios, incluyendo su hábito de pago, ante las centrales de información tales como TRANSUNION (antes CIFIN), EXPERIAN (DATACRÉDITO) y demás operadores de información o entidades nacionales o extranjeras encargadas del manejo de datos personales, comerciales o económicos.</p>

<p>EL ARRENDATARIO y el COARRENDATARIO exoneran expresamente de toda responsabilidad a EL ARRENDADOR y a las entidades operadoras de información por la inclusión, reporte o actualización de los datos suministrados, siempre que dicha actuación se realice conforme a la ley.</p>

<p><span class="clause-title">VIGÉSIMA QUINTA: IMPUTACIÓN DEL PAGO.</span> Todo pago que EL ARRENDATARIO o el COARRENDATARIO efectúe a favor de EL ARRENDADOR, o de quien represente sus derechos, con ocasión de las obligaciones derivadas del presente contrato, se imputará conforme al siguiente orden, salvo pacto escrito en contrario:</p>
<ol>
  <li>Gastos y costos de cobranza extrajudicial y/o judicial, cuando a ello hubiere lugar.</li>
  <li>Gestión de cartera.</li>
  <li>Intereses moratorios causados.</li>
  <li>Cánones de arrendamiento adeudados.</li>
  <li>Cuotas de administración vencidas.</li>
  <li>Valores correspondientes a servicios públicos.</li>
  <li>Daños, faltantes o deterioros ocasionados al inmueble.</li>
  <li>Cláusula penal pactada.</li>
  <li>Obligaciones no vencidas.</li>
</ol>
<p>La imputación se realizará prioritariamente a las obligaciones de mayor antigüedad y, en forma sucesiva, a las más recientes, conforme al orden establecido en la presente cláusula.</p>

<p><span class="clause-title">VIGÉSIMA SEXTA: COMPRA DEL INMUEBLE ARRENDADO.</span> En el evento en que EL ARRENDATARIO manifieste su intención de adquirir en propiedad el inmueble objeto del presente contrato, se obliga a adelantar todas las gestiones correspondientes a través de EL ARRENDADOR, a quien reconoce desde ahora como intermediario de la eventual compraventa directa.</p>

<p><span class="clause-title">PARÁGRAFO:</span> En caso de que se presente una opción de venta del inmueble a favor de un tercero, EL ARRENDATARIO se obliga a permitir la exhibición del inmueble dentro de un plazo máximo de dos (2) días calendario contados a partir de la solicitud presentada por EL ARRENDADOR, fijando de común acuerdo la fecha y hora de la visita.</p>

<p><span class="clause-title">VIGÉSIMA SÉPTIMA: ORIGEN DE INGRESOS Y CUMPLIMIENTO NORMATIVO.</span> LAS PARTES declaran, bajo la gravedad del juramento, que los recursos y fondos utilizados para el cumplimiento de las obligaciones derivadas del presente contrato provienen exclusivamente de actividades lícitas, que no se encuentran registradas en listas restrictivas o de prevención de lavado de activos y financiación del terrorismo, nacionales o internacionales, y que no hacen parte de las categorías de lavado de activos relacionadas con la conversión o el movimiento de recursos.</p>

<p>Igualmente, LAS PARTES declaran que no se encuentran incluidas en listas de terroristas, criminales o sanciones emitidas por autoridades nacionales o extranjeras, incluyendo, sin limitarse a, las listas expedidas por las autoridades de la República de Colombia, el Reino Unido y los Estados Unidos de América, tales como las listas SDN/SDT y SDGT emitidas por la OFAC y la lista de Organizaciones Terroristas Extranjeras (FTO) emitida por el Departamento de Estado de los Estados Unidos.</p>

<p><span class="clause-title">PARÁGRAFO:</span> El incumplimiento de cualquiera de las declaraciones contenidas en la presente cláusula, así como la inclusión posterior de cualquiera de LAS PARTES en las listas restrictivas aquí mencionadas, constituirá causal suficiente para la terminación inmediata del presente contrato, sin perjuicio de las acciones legales a que haya lugar.</p>

<p><span class="clause-title">VIGÉSIMA OCTAVA: TRATAMIENTO DE DATOS PERSONALES.</span> EL ARRENDATARIO y EL COARRENDATARIO autorizan de manera previa, expresa e informada a EL ARRENDADOR para recolectar, almacenar, usar, circular, actualizar, suprimir y en general tratar sus datos personales, con el fin de dar cumplimiento al contrato de arrendamiento y fianza, realizar gestiones de cobro, enviar notificaciones e información comercial relacionada con sus servicios, conforme a sus políticas de tratamiento de datos personales y a la normatividad vigente.</p>

<p>Se informa a los titulares que es facultativo suministrar datos sensibles o de menores de edad y que podrán ejercer en cualquier momento los derechos de conocer, actualizar, rectificar o suprimir su información, de conformidad con la Ley 1581 de 2012 y sus decretos reglamentarios.</p>

<p>La autorización incluye la consulta de información ante entidades públicas o privadas nacionales o extranjeras, tales como operadores de seguridad social, administradoras de pensiones, DIAN, Fiscalía u otras, con fines de análisis, validación, gestión y administración del riesgo crediticio, prevención del fraude, lavado de activos y financiación del terrorismo, así como la elaboración de indicadores o puntajes crediticios.</p>

<p><span class="clause-title">VIGÉSIMA NOVENA: MÉRITO EJECUTIVO.</span> El presente contrato constituye título con mérito ejecutivo para LAS PARTES, en los términos previstos en el Código General del Proceso y demás normas concordantes, para exigir el cumplimiento de las obligaciones aquí contenidas, en caso de incumplimiento.</p>

<p><span class="clause-title">TRIGÉSIMA: NOTIFICACIONES Y DOMICILIO CONTRACTUAL – MEDIOS ELECTRÓNICOS.</span> LAS PARTES acuerdan que todas las comunicaciones, avisos y notificaciones que deban realizarse con ocasión del presente contrato podrán efectuarse por medios físicos o electrónicos, incluyendo correo electrónico, mensajes de datos y plataformas de terceros que permitan acreditar: (i) la fecha y hora de envío, (ii) el contenido de la comunicación y (iii) la identificación del remitente y del destinatario. Las notificaciones electrónicas se entenderán válidamente realizadas en la fecha y hora que conste en el sistema utilizado para su envío, para todos los efectos legales.</p>

<p>Para todos los efectos legales derivados del presente contrato, LAS PARTES fijan como direcciones físicas y electrónicas de notificación las siguientes, comprometiéndose a informar por escrito cualquier modificación; en caso contrario, las notificaciones enviadas a las direcciones aquí registradas se entenderán plenamente válidas:</p>

<p><strong>Arrendador</strong><br>
Dirección: {{arrendador.domicilio_direccion}}<br>
Municipio: {{arrendador.domicilio_ciudad}}<br>
{{#if arrendador.email_recaudo}}Correo electrónico: {{arrendador.email_recaudo}}<br>{{/if}}
{{#if arrendador.whatsapp_recaudo}}Celular: {{arrendador.whatsapp_recaudo}}{{/if}}</p>

<p><strong>Arrendatario</strong><br>
Dirección: {{arrendatario.direccion}}<br>
Municipio: {{arrendatario.ciudad}}<br>
Correo electrónico: {{arrendatario.email}}<br>
Celular: {{arrendatario.celular}}</p>

{{#if coarrendatario}}
<p><strong>Coarrendatario</strong><br>
Dirección: {{coarrendatario.direccion}}<br>
Municipio: {{coarrendatario.ciudad}}<br>
Correo electrónico: {{coarrendatario.email}}<br>
Celular: {{coarrendatario.celular}}</p>
{{/if}}

<p><span class="clause-title">TRIGÉSIMA PRIMERA: DOMICILIO CONTRACTUAL.</span> Para todos los efectos judiciales y extrajudiciales, las partes declaran la ciudad de {{arrendador.domicilio_ciudad}} como su domicilio principal.</p>

<p><span class="clause-title">TRIGÉSIMA SEGUNDA: TOTALIDAD DEL ACUERDO.</span> LAS PARTES manifiestan que el presente contrato constituye un acuerdo completo y total acerca de su objeto, y reemplaza y deja sin efecto alguno cualquier otro acuerdo verbal o documento referido al inmueble objeto de este contrato.</p>

<p>El presente contrato se perfecciona con la firma de LAS PARTES y, en señal de conformidad, se suscribe en dos (2) ejemplares del mismo tenor y a un solo efecto, en la ciudad de {{arrendador.domicilio_ciudad}}, a los {{contrato.fecha_dia}} ({{contrato.fecha_dia_letras}}) días del mes de {{contrato.fecha_mes_nombre}} de {{contrato.fecha_anio}}.</p>

<div class="firma-block">
  <p><strong>Arrendatario</strong></p>
  <div class="firma-line"></div>
  <p>{{arrendatario.nombre_completo}}<br>C.C N° {{arrendatario.numero_documento}}</p>
</div>

{{#if coarrendatario}}
<div class="firma-block">
  <p><strong>Coarrendatario</strong></p>
  <div class="firma-line"></div>
  <p>{{coarrendatario.nombre_completo}}<br>C.C N° {{coarrendatario.numero_documento}}</p>
</div>
{{/if}}

<div class="firma-block">
  <p><strong>Arrendador</strong></p>
  <div class="firma-line"></div>
  <p>{{#if arrendador.representante_legal}}{{arrendador.representante_legal}}<br>R.L. {{arrendador.razon_social}}{{else}}{{arrendador.razon_social}}<br>C.C/NIT N° {{arrendador.numero_documento}}{{/if}}</p>
</div>

</body>
</html>$contrato$,
  $$[
    {"clave": "arrendador.razon_social", "fuente": "perfiles.nombre + apellido"},
    {"clave": "arrendador.tipo_documento_label", "fuente": "perfiles.tipo_documento (CC/NIT/CE)"},
    {"clave": "arrendador.numero_documento", "fuente": "perfiles.numero_documento"},
    {"clave": "arrendador.representante_legal", "fuente": "perfiles.representante_legal"},
    {"clave": "arrendador.domicilio_direccion", "fuente": "perfiles.domicilio_direccion"},
    {"clave": "arrendador.domicilio_ciudad", "fuente": "perfiles.domicilio_ciudad"},
    {"clave": "arrendador.matricula_arrendador", "fuente": "perfiles.matricula_arrendador"},
    {"clave": "arrendador.logo_url", "fuente": "perfiles.logo_url (solo inmobiliaria)"},
    {"clave": "arrendador.es_inmobiliaria", "fuente": "perfiles.rol === 'inmobiliaria'"},
    {"clave": "arrendador.whatsapp_recaudo", "fuente": "perfiles.whatsapp_recaudo"},
    {"clave": "arrendador.email_recaudo", "fuente": "perfiles.email_recaudo"},
    {"clave": "arrendador.cuenta_banco", "fuente": "perfiles.cuenta_recaudo_banco"},
    {"clave": "arrendador.cuenta_tipo", "fuente": "perfiles.cuenta_recaudo_tipo"},
    {"clave": "arrendador.cuenta_numero", "fuente": "perfiles.cuenta_recaudo_numero"},
    {"clave": "arrendador.cuenta_titular_nombre", "fuente": "perfiles.cuenta_recaudo_titular_nombre"},
    {"clave": "arrendador.cuenta_titular_nit", "fuente": "perfiles.cuenta_recaudo_titular_nit"},
    {"clave": "arrendatario.nombre_completo", "fuente": "solicitantes.nombre + apellido"},
    {"clave": "arrendatario.numero_documento", "fuente": "solicitantes.numero_documento"},
    {"clave": "arrendatario.direccion", "fuente": "solicitantes.direccion"},
    {"clave": "arrendatario.ciudad", "fuente": "solicitantes.ciudad"},
    {"clave": "arrendatario.email", "fuente": "solicitantes.email"},
    {"clave": "arrendatario.celular", "fuente": "solicitantes.telefono"},
    {"clave": "coarrendatario", "fuente": "expedientes.codeudor_* (opcional)"},
    {"clave": "inmueble.direccion", "fuente": "inmuebles.direccion"},
    {"clave": "inmueble.ciudad", "fuente": "inmuebles.ciudad"},
    {"clave": "inmueble.ubicacion_detallada", "fuente": "inmuebles.direccion + ciudad + barrio + departamento"},
    {"clave": "inmueble.es_propiedad_horizontal", "fuente": "inmuebles.administracion > 0 (heuristico)"},
    {"clave": "inmueble.tiene_parqueadero", "fuente": "inmuebles.parqueadero"},
    {"clave": "inmueble.tiene_cuarto_util", "fuente": "TODO: agregar columna inmuebles.cuarto_util"},
    {"clave": "contrato.fecha_dia", "fuente": "now()"},
    {"clave": "contrato.fecha_dia_letras", "fuente": "now() en letras"},
    {"clave": "contrato.fecha_mes_nombre", "fuente": "now() mes en espanol"},
    {"clave": "contrato.fecha_anio", "fuente": "now().year"},
    {"clave": "contrato.duracion_meses", "fuente": "contratos.duracion_meses"},
    {"clave": "contrato.duracion_meses_letras", "fuente": "contratos.duracion_meses en letras"},
    {"clave": "contrato.fecha_inicio_completa", "fuente": "contratos.fecha_inicio formateada"},
    {"clave": "contrato.fecha_fin_completa", "fuente": "contratos.fecha_fin formateada"},
    {"clave": "canon.valor_numerico", "fuente": "contratos.valor_arriendo formateado"},
    {"clave": "canon.valor_letras", "fuente": "contratos.valor_arriendo en letras"},
    {"clave": "config.afianzamiento_mensual", "fuente": "configuracion_sistema.valor_afianzamiento_mensual"},
    {"clave": "config.afianzamiento_mensual_letras", "fuente": "configuracion_sistema.valor_afianzamiento_mensual en letras"},
    {"clave": "config.comision_porcentaje", "fuente": "configuracion_sistema.comision_intermediacion_porcentaje"}
  ]$$::JSONB,
  TRUE
)
ON CONFLICT DO NOTHING;
