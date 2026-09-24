// Texto que Cofianza reenvía a un tercero (WhatsApp, correo): sin etiquetas ni
// enlaces, o sería phishing con su marca. Cualquier punto (también ．。｡) pegado
// a dos o más letras es un dominio («pago-seguro.info», «www.cofianza-pagos.co»,
// «is.gd/x», «FALSO．CO»), sea cual sea la terminación; los de «J.R.», «8 a.m.»
// o «No.301» no lo son.
const CON_ENLACE = /[<>]|h(?:tt|xx)ps?:|[\p{L}\d-][.．。｡]\p{L}{2,}/iu;

export const sinEnlaces = (v: string): boolean => !CON_ENLACE.test(v);

// Nombre de persona: empieza por letra; luego letras, espacios, puntos, guiones
// y apóstrofos (también el ’ de los teclados de celular y el ´ que se usa en su
// lugar). Sin dominios.
const SOLO_NOMBRE = /^\p{L}[\p{L}\p{M}'’´ .-]*$/u;

export const esNombrePersona = (v: string): boolean => SOLO_NOMBRE.test(v) && sinEnlaces(v);
