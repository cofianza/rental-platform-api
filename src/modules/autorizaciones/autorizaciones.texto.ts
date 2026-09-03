// ============================================================
// Texto legal de la autorizacion habeas data + su version.
//
// Vive aparte del service porque el flujo 8.4 exige guardar "el texto integro
// de la autorizacion tal como fue presentado y aceptado, con su version", y
// hay DOS flujos que presentan y aceptan ese texto: el del solicitante
// (modulo autorizaciones, con OTP) y el del co-arrendatario invitado (modulo
// coarrendatarios, con casilla). Importarlo desde un modulo neutral evita el
// ciclo coarrendatarios -> autorizaciones -> estudios -> coarrendatarios.
//
// Los DOS textos comparten encabezado y cuerpo pero difieren en el parrafo 2
// ("Naturaleza y alcance"), que es donde se describe COMO se manifiesta el
// consentimiento. Por eso cada uno tiene su propia version: si los dos
// llevaran '2.0', la version dejaria de identificar que se acepto, que es
// exactamente para lo que el 8.4 la pide.
//
// Al cambiar un texto hay que subir SU version: la version viaja congelada en
// cada fila y es lo que permite reconstruir despues que se acepto exactamente.
// ============================================================

/** Version del texto que se presenta al SOLICITANTE (aceptacion por OTP). */
export const VERSION_TERMINOS = '2.0';

/**
 * Version del texto que se presenta al CO-ARRENDATARIO invitado (aceptacion
 * por casilla, sin OTP). Es un texto materialmente distinto: cambia el
 * parrafo 2 y suma la clausula 7.
 */
export const VERSION_TERMINOS_COARRENDATARIO = '2.0-coarrendatario';

const ENCABEZADO = `AUTORIZACIÓN PARA EL TRATAMIENTO DE DATOS PERSONALES

1. Responsable del tratamiento
COFIANZA S.A.S., NIT 902.038.122, domicilio en Itagüí, Antioquia, Colombia. Canal de atención: hola@cofianza.co · Sitio web: www.cofianza.co · Oficial de protección de datos: datospersonales@cofianza.co`;

// Mecanismo de aceptacion del flujo del solicitante: enlace + OTP.
const NATURALEZA_OTP = `2. Naturaleza y alcance
Al validar el código OTP enviado a mi celular o correo, autorizo de manera libre, previa, expresa, informada e inequívoca a COFIANZA S.A.S. y a sus encargados (proveedores tecnológicos, operadores de centrales de riesgo, firmas de cobranza, abogados y terceros necesarios) a recolectar, almacenar, usar, consultar, verificar, actualizar, circular, compartir, transmitir, transferir, suprimir y tratar mis datos personales conforme a las finalidades aquí descritas. La validación OTP constituye firma electrónica (Ley 527/1999 y Decreto 2364/2012) con la misma validez que la firma manuscrita. Se conservará como prueba: código OTP, canal, IP, fecha/hora, dispositivo y documento autorizado.`;

// Mecanismo de aceptacion del flujo del co-arrendatario: casilla en pantalla.
// NO hay OTP en ese flujo (no se envia codigo, no se escribe metodo_firma ni
// referencia_otp, no hay fila en autorizacion_otps), asi que congelar el
// parrafo del OTP hacia que la propia evidencia se contradijera: describia un
// mecanismo de firma que la fila demuestra que no ocurrio.
const NATURALEZA_CASILLA = `2. Naturaleza y alcance
Al marcar las casillas de aceptación de esta pantalla, autorizo de manera libre, previa, expresa, informada e inequívoca a COFIANZA S.A.S. y a sus encargados (proveedores tecnológicos, operadores de centrales de riesgo, firmas de cobranza, abogados y terceros necesarios) a recolectar, almacenar, usar, consultar, verificar, actualizar, circular, compartir, transmitir, transferir, suprimir y tratar mis datos personales conforme a las finalidades aquí descritas. Marcar las casillas es una conducta inequívoca de la que se concluye mi autorización (Decreto 1377 de 2013, artículo 7). Se conservará como prueba: el texto íntegro aquí presentado con su versión, mi número y tipo de documento, la IP, la fecha y hora exactas, y el dispositivo y navegador desde los que acepté.`;

const CUERPO = `3. Marco normativo
- Ley 1266 de 2008 — Habeas Data Financiero.
- Ley 1581 de 2012 — Protección de Datos Personales.
- Decreto 1377 de 2013 — requisitos de la autorización.
- Ley 527 de 1999 y Decreto 2364 de 2012 — firma electrónica.
- Circular Externa 005 de 2017 SIC — datos en cobranza.

4. Datos objeto de tratamiento
Identificación, contacto, financieros y crediticios (historial, score, obligaciones, cuentas, ingresos), comerciales (contratos, inmuebles, cánones, comisiones), del servicio de fianza (modalidad, siniestros, cobranza, pagos) y técnicos (IP, metadatos, logs, firma electrónica). No se recolectan datos sensibles ni de menores; el servicio es solo para mayores de 18 años.

5.1. Finalidades obligatorias
- Evaluar perfil de riesgo y capacidad de pago para aprobar o rechazar la fianza.
- Administrar la relación contractual y el servicio de fianza.
- Consultar, verificar, reportar y actualizar información ante centrales de riesgo (Datacrédito Experian, TransUnion), Ley 1266.
- Contacto, notificación, requerimiento y cobranza por cualquier medio (llamada, WhatsApp, correo, SMS, voz).
- Compartir o transferir información con encargados necesarios para la operación.
- Prevenir fraude y suplantación conforme a SARLAFT.
- Cumplir obligaciones legales, regulatorias y requerimientos de autoridades.
- Construir y administrar bases de datos de comportamiento de pago en arrendamientos, para actuar como fuente y eventualmente operador de información (Art. 3, Ley 1266): recopilar historial, compartirlo con usuarios autorizados por la ley o por el titular, permitir consulta de terceros con interés legítimo, y generar calificaciones e indicadores de riesgo.
- Análisis mediante scoring automatizado, con derecho del titular a revisión humana de decisiones que le afecten significativamente.

5.2. Finalidades opcionales
No son necesarias para el servicio y su no autorización no condiciona el acceso. Se gestionan en el paso "Beneficios": (i) analítica avanzada, segmentación y perfilamiento comercial; (ii) comunicaciones comerciales, ofertas y mercadeo; (iii) compartir el historial de buen pago como referencia ante terceros del ecosistema.

6. Reporte a centrales de riesgo (Ley 1266)
En caso de mora, la información podrá reportarse negativamente con aviso previo de 20 días calendario (Art. 12). Permanencia del dato negativo: máximo el doble de la mora, sin exceder 4 años desde el pago o exigibilidad.`;

const CLAUSULA_COARRENDATARIO = `7. Condición de co-arrendatario
Acepto la invitación a figurar como CO-ARRENDATARIO del contrato de arrendamiento indicado, junto al titular. Entiendo que Cofianza consultará mi historial en centrales de información para evaluar la solicitud conjunta, y que esta autorización cubre esa consulta.`;

// OJO: el resultado tiene que ser byte a byte el texto de la version 2.0 que
// ya esta congelado en las filas historicas. Cualquier cambio aqui exige subir
// VERSION_TERMINOS.
export const TEXTO_LEGAL = [ENCABEZADO, NATURALEZA_OTP, CUERPO].join('\n\n');

// Variante que se presenta al CO-ARRENDATARIO invitado. Mismo instrumento
// legal, con el parrafo de aceptacion que corresponde a SU mecanismo (casilla,
// no OTP) y la clausula que describe su rol: no es el titular del contrato,
// entra como arrendatario solidario junto al titular.
export const TEXTO_LEGAL_COARRENDATARIO = [
  ENCABEZADO,
  NATURALEZA_CASILLA,
  CUERPO,
  CLAUSULA_COARRENDATARIO,
].join('\n\n');
