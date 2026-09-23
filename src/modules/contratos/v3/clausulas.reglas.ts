/**
 * Contratos V3 — reglas de las cláusulas adicionales (Entrega 4, diseño §5.2 y §6).
 *
 * Puro: sin Supabase, sin reloj, sin red. Es el control preventivo SIEMPRE
 * encendido (V3 §5.3): detecta con reglas fijas el contenido que una cláusula
 * adicional no puede traer y lo que el contrato no puede imprimir. No es una
 * revisión jurídica. La IA (clausulas.ia.ts, apagada) corre después y solo
 * puede AGREGAR hallazgos.
 *
 * Cómo se escanea: título y texto se pasan a NFC (una tilde pegada en NFD
 * desde un PDF o un Mac no parte la palabra) y `titulo + '. ' + texto` se
 * corta en segmentos (oraciones y «;») sobre ese texto; cada regla corre sobre
 * el segmento "plegado" (minúsculas, sin tildes, todo lo que no es [a-z0-9%$]
 * → espacio, MISMA longitud) con el título delante: «Mascotas» + «Está
 * prohibida su tenencia» se juzgan juntos. El tramo que dispara se copia
 * literal (del texto en NFC) como `fragmento`. Estructurales primero, luego
 * categorías; cada código sale una sola vez. Todos los cuantificadores de las
 * reglas están acotados y las excepciones miran ventanas acotadas: el costo es
 * lineal en el largo del texto por el del título (≤ 120).
 *
 * Notación del diseño: `a →n b` = b a lo sumo n palabras después de a;
 * `a ⇄n b` = en cualquier orden; `*` = cualquier terminación de palabra.
 */

import { createHash } from 'crypto';
import { AppError } from '@/lib/errors';
import type { CodigoHallazgo, Hallazgo, OrigenClausula } from './asistente.types';
import { mayus } from './formato';
import { MARCADOR } from './motor';

/** Sube cuando cambie cualquier regla (se guarda con cada validación). */
export const REGLAS_VERSION = 'v2';

// Adenda 1 del módulo de contratos, respuesta 13: dos categorías con responsabilidad
// distinta. La aceptación (AVISO_RESPONSABILIDAD) cubre las propias y los datos que
// la inmobiliaria completa en los modelos; el texto de un modelo sugerido sin
// cambios es de Cofianza (AVISO_MODELOS).
export const AVISO_VERSION = '2026-09-23b';
export const AVISO_RESPONSABILIDAD =
  'Las cláusulas propias —las que redacta la inmobiliaria y los modelos sugeridos por Cofianza que ella modifica— y los datos que la inmobiliaria completa en los modelos son de autoría, iniciativa y responsabilidad exclusiva de la inmobiliaria, que los incorpora como EL ARRENDADOR. COFIANZA S.A.S. no los revisa, no los aprueba y no los avala; la validación automática solo detecta algunos contenidos prohibidos y no es una revisión jurídica. La inmobiliaria asume de manera íntegra y exclusiva las consecuencias y los costos que se deriven de ellos y mantendrá indemne a COFIANZA S.A.S., en los términos de la cláusula «Totalidad del acuerdo y cláusulas adicionales».';
export const AVISO_MODELOS =
  'Las cláusulas tomadas sin cambios de los Modelos sugeridos por Cofianza son texto de COFIANZA S.A.S.: ese texto no es de autoría exclusiva de la inmobiliaria y no queda cubierto por la indemnidad de la cláusula «Totalidad del acuerdo y cláusulas adicionales». Los datos que la inmobiliaria completa en un modelo sí son de su responsabilidad, y un modelo que ella modifica pasa a ser una cláusula propia.';
export const AVISO_PREVALENCIA =
  'Las condiciones de la fianza de COFIANZA S.A.S. prevalecen: si una cláusula adicional las contradice, se entiende no escrita en aquello que las contradiga.';

/** Máximo de [[campo]] distintos en una cláusula de la biblioteca (D11). */
export const MAX_CAMPOS = 10;

export type Destinacion = 'vivienda';
export interface OpcionesValidacion {
  destinacion: Destinacion;
  sinCoarrendatario: boolean;
  biblioteca?: boolean;
}

type Entrada = Omit<Hallazgo, 'fragmento' | 'fuente' | 'indice'>;

// ── Catálogo de mensajes (diseño §6; vivienda) ──

export const CATALOGO: Record<CodigoHallazgo, Entrada> = {
  deposito: {
    codigo: 'deposito',
    etiqueta: 'Depósito o garantía en dinero',
    mensaje:
      'La cláusula pide un depósito, una garantía en dinero, meses de canon anticipados como garantía u otra caución real (prenda, hipoteca, CDT, cheque en garantía). En la vivienda urbana no se pueden exigir; el cumplimiento del arrendatario ya lo respalda la fianza de COFIANZA S.A.S.',
    norma: 'Ley 820 de 2003, art. 16; Cláusula CUARTA (Fianza COFIANZA).',
  },
  mascotas: {
    codigo: 'mascotas',
    etiqueta: 'Animales de compañía',
    mensaje:
      'La cláusula prohíbe, condiciona (autorización previa, número máximo, raza o tamaño, cobro adicional) o sanciona con la terminación la tenencia de animales de compañía, y eso no se puede pactar. Sí puedes pactar tenencia responsable: que el arrendatario responda por daños, aseo, desinfección, plagas, multas y el reglamento de propiedad horizontal.',
    norma:
      'Ley 1801 de 2016, art. 117, y jurisprudencia constitucional; Leyes 1774 de 2016 y 746 de 2002 (tenencia responsable); cláusula «Ocupantes y tenencia responsable de animales de compañía».',
  },
  incremento: {
    codigo: 'incremento',
    etiqueta: 'Incremento del canon',
    mensaje:
      'El canon de vivienda solo puede reajustarse cada doce (12) meses y hasta el cien por ciento (100 %) del IPC del año calendario anterior, y el contrato ya lo pacta así. Una cláusula adicional no puede fijar un porcentaje, puntos sobre el IPC, otro índice ni otra periodicidad.',
    norma: 'Ley 820 de 2003, art. 20; Cláusula TERCERA, Parágrafo Segundo (Incrementos del canon).',
  },
  fianza: {
    codigo: 'fianza',
    etiqueta: 'Condiciones de la fianza',
    mensaje:
      'La cláusula se refiere a la fianza o a COFIANZA S.A.S. La cobertura, el tope de dieciocho (18) cánones, la subrogación, la prima, la tarifa y los avisos del arrendador a COFIANZA S.A.S. los rige el contrato y no cambian sin aceptación escrita de COFIANZA S.A.S.; una cláusula adicional no puede tocarlos.',
    norma:
      'Cláusula CUARTA y sus parágrafos; cláusula «Aceptación irrevocable de las condiciones relacionadas con COFIANZA S.A.S.», Parágrafo Primero; cláusula «Totalidad del acuerdo y cláusulas adicionales», Parágrafo.',
  },
  renuncia: {
    codigo: 'renuncia',
    etiqueta: 'Renuncia de derechos del arrendatario',
    mensaje:
      'La cláusula hace renunciar al arrendatario a derechos que la ley de vivienda urbana le reconoce (reparaciones necesarias, goce pacífico, preaviso, indemnización, prórroga o acudir a un juez) o libera al arrendador de sus responsabilidades legales, y eso no se puede pactar. La renuncia a los requerimientos para constituir en mora sí está permitida y el contrato ya la trae.',
    norma:
      'Ley 820 de 2003 (el contrato cita su art. 27 en «Reparaciones, mejoras y adecuaciones» y su Capítulo VII en «Causales de terminación»).',
  },
  terminacion: {
    codigo: 'terminacion',
    etiqueta: 'Terminación, prórroga y preavisos',
    mensaje:
      'La cláusula cambia la vigencia, la prórroga, los preavisos, las causales o las indemnizaciones de terminación. Ese régimen lo fija la Ley 820 de 2003 y ya está en el contrato. Si buscas que el incumplimiento de una obligación nueva permita terminar el contrato, no hace falta pactarlo: el incumplimiento de cualquier obligación del contrato ya es causal.',
    norma:
      'Ley 820 de 2003, Capítulo VII; cláusulas «Vigencia del contrato» (parágrafo «Prórrogas»), «Causales de terminación» y «Preavisos y terminación unilateral».',
  },
  tenencia: {
    codigo: 'tenencia',
    etiqueta: 'Recuperar el inmueble sin juez',
    mensaje:
      'La cláusula deja al arrendador recuperar el inmueble por su cuenta (cambiar guardas, retirar bienes, cortar servicios, impedir el acceso o desalojar). A falta de entrega voluntaria, la tenencia solo se recupera por la vía judicial.',
    norma: 'Código General del Proceso, art. 384; cláusula «Abandono del inmueble», apartado «Recuperación de la tenencia».',
  },
  modifica_contrato: {
    codigo: 'modifica_contrato',
    etiqueta: 'Modificación del contrato',
    mensaje:
      'Las cláusulas adicionales solo agregan: no pueden modificar, reemplazar, dejar sin efecto ni prevalecer sobre las cláusulas del contrato. Si necesitas cambiar el texto del contrato, escribe a Cofianza: requiere autorización de su Gerencia General.',
    norma:
      'Regla de uso de la plantilla de Cofianza (solo se agregan cláusulas); cláusula «Totalidad del acuerdo y cláusulas adicionales».',
  },
  no_imprimible: {
    codigo: 'no_imprimible',
    etiqueta: 'Texto que no se puede imprimir',
    mensaje:
      'Quita XXX, líneas ___, llaves { }, corchetes [[ ]], «NO APLICA», «null», emojis o caracteres invisibles o de otro alfabeto: el contrato no puede imprimirlos.',
    norma: null,
  },
  coarrendatario: {
    codigo: 'coarrendatario',
    etiqueta: 'Menciona al coarrendatario',
    mensaje: 'Este contrato no tiene coarrendatario y la cláusula lo menciona. Edítala o no la uses en este contrato.',
    norma: null,
  },
  instrucciones: {
    codigo: 'instrucciones',
    etiqueta: 'Instrucciones al sistema',
    mensaje:
      'El texto incluye instrucciones dirigidas al sistema de revisión y no a las partes del contrato. Quítalas.',
    norma: null,
  },
  revision_automatica: {
    codigo: 'revision_automatica',
    etiqueta: 'Sin validación automática',
    mensaje:
      'La revisión automática no pudo procesar este texto. Reformúlalo con lenguaje contractual; si crees que es un error, escríbenos por Soporte.',
    norma: null,
  },
  cita_numero: {
    codigo: 'cita_numero',
    etiqueta: 'Cita por número',
    mensaje:
      'Mencionas una cláusula por su número. La numeración cambia según los datos de cada contrato: nómbrala por su título.',
    norma: null,
  },
};

// ── Huellas, campos y plegado ──

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
export const shaClausula = (c: { titulo: string; texto: string }) => sha256(`${c.titulo}\n${c.texto}`);
export const huella = (cs: { titulo: string; texto: string }[]) =>
  sha256(JSON.stringify(cs.map((c) => [c.titulo, c.texto])));

/** Misma longitud que s: cada unidad UTF-16 → letra base minúscula, o espacio. */
export const plegar = (s: string) =>
  Array.from({ length: s.length }, (_, i) => {
    const d = s[i].normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()[0] ?? ' ';
    return /[a-z0-9%$]/.test(d) ? d : ' ';
  }).join('');

/** [[nombre]]: 1-40 letras, dígitos o espacios, sin espacios en los bordes. */
const CAMPO = /\[\[([\p{L}\d](?:[\p{L}\d ]{0,38}[\p{L}\d])?)\]\]/gu;

/** Nombres de los [[campo]] del texto, únicos y en orden de aparición. */
export function campos(texto: string): string[] {
  return [...new Set(Array.from(texto.matchAll(CAMPO), (m) => m[1]))];
}

/** Reemplaza cada [[campo]] por su valor; el que no tenga valor queda tal cual. */
export function llenar(texto: string, valores: Record<string, string>): string {
  return texto.replace(CAMPO, (m, n: string) => (Object.hasOwn(valores, n) ? valores[n] : m));
}

/** Forma Unicode y espacios: lo único que se ignora al comparar con el modelo. */
const normalizar = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim();

/**
 * Adenda 1 del módulo de contratos, respuesta 13: una cláusula es texto de
 * Cofianza ('biblioteca') solo si es un modelo sugerido SIN cambios: título y
 * texto, con sus [[campo]] llenos, iguales a los del modelo. Todo lo demás —las
 * propias y un modelo editado— es autoría exclusiva del arrendador ('propia').
 */
export function categoriaClausula(
  c: { titulo: string; texto: string; valores: Record<string, string> | null },
  modelo: { inmobiliaria_id: string | null; titulo: string; texto: string } | undefined,
): OrigenClausula {
  return modelo?.inmobiliaria_id === null &&
    normalizar(modelo.titulo) === normalizar(c.titulo) &&
    normalizar(llenar(modelo.texto, c.valores ?? {})) === normalizar(c.texto)
    ? 'biblioteca'
    : 'propia';
}

/**
 * Lo que cubre la aceptación de responsabilidad (resp. 13): las propias y los
 * modelos con datos, porque esos datos los escribe la inmobiliaria.
 */
export const requiereAceptacion = (c: { origen: OrigenClausula; valores: Record<string, string> | null }): boolean =>
  c.origen === 'propia' || Object.keys(c.valores ?? {}).length > 0;

// ── Mini-lenguaje de reglas sobre texto plegado (solo [a-z0-9%$ ]) ──

/** [inicio, fin) dentro del texto que se escanea. */
export type Tramo = [number, number];

const S = ' {1,12}'; // separador entre palabras
const RESTO = '[^ ]{0,30}'; // «*»: cualquier terminación de palabra
/** Palabra(s) completa(s): « » = separador, «*» = cualquier terminación. */
const w = (p: string) => `(?<![^ ])(?:${p.replace(/ /g, S).replace(/\*/g, RESTO)})(?![^ ])`;
/** a →n b: b a lo sumo n palabras después de a (la más cercana). */
const tras = (a: string, n: number, b: string) => `${a}(?:${S}[^ ]{1,40}){0,${n}}?${S}${b}`;
/** a ⇄n b: en cualquier orden. */
const cerca = (a: string, n: number, b: string) => `(?:${tras(a, n, b)}|${tras(b, n, a)})`;
const rx = (...ps: string[]) => new RegExp(ps.join('|'), 'g');

/** Primer disparo que la excusa no perdona. */
function primero(re: RegExp, f: string, excusa?: (m: RegExpExecArray) => boolean): Tramo | null {
  re.lastIndex = 0;
  for (let m = re.exec(f); m; m = re.exec(f)) {
    if (!excusa?.(m)) return [m.index, m.index + m[0].length];
    re.lastIndex = m.index + 1;
  }
  return null;
}
const hay = (re: RegExp, f: string) => primero(re, f) !== null;
/** Inicio de cada disparo, en orden. */
function inicios(re: RegExp, f: string): number[] {
  const r: number[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(f); m; m = re.exec(f)) r.push(m.index);
  return r;
}
/** Último inicio de un disparo (−1 si no hay). */
const ultimo = (re: RegExp, f: string) => inicios(re, f).at(-1) ?? -1;
const une = (...ts: Tramo[]): Tramo => [Math.min(...ts.map((t) => t[0])), Math.max(...ts.map((t) => t[1]))];
/** Los n caracteres antes de i. */
const antes = (f: string, i: number, n: number) => f.slice(Math.max(0, i - n), i);

const DOS_A_DOCE = 'dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce';
const UNO_A_ONCE = 'un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once';
const NUMERO =
  '[0-9]{1,4}|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|' +
  'dieci[a-z]{4,6}|veinte|veinti[a-z]{3,6}|treinta|cuarenta|cincuenta|sesenta|noventa';
const BICHO = '(mascota|animal|perr[oa]|gat[oa]|canin[oa]|felin[oa])*';

// ── Quién hace la acción (tenencia, mascotas) ──

const PARTE = rx(
  w('(co)?arrendatari*|inquilin*|locatari*|arrendador*|propietari[oa]s?|inmobiliaria|empresa*|prestador*'),
);
/** «al ARRENDADOR», «del ARRENDATARIO», «con EL ARRENDADOR»: complemento, no sujeto. */
const COMPLEMENTO = /(?<![^ ])(?:a|al|del|de|con|para|por|contra|ante|sobre|entre|hacia|segun)(?: {1,12}(?:el|la|los|las))? {1,12}$/;
/** … salvo «autoriza (expresamente) al ARRENDADOR para»: ese es quien actúa. */
const FACULTA_A = /(?<![^ ])(?:autoriz|facult|permit|habilit)[a-z]{0,12}(?: {1,12}[a-z]{1,20}mente)? {1,12}(?:a|al)(?: {1,12}(?:el|la))? {1,12}$/;
type Lado = 'arrendatario' | 'arrendador' | 'tercero';
interface Sujeto {
  t: Tramo;
  lado: Lado;
}

/** Partes en posición de sujeto; en el título (primeros h caracteres) cualquier mención es el tema. */
function sujetos(f: string, h: number): Sujeto[] {
  const r: Sujeto[] = [];
  PARTE.lastIndex = 0;
  for (let m = PARTE.exec(f); m; m = PARTE.exec(f)) {
    const v = antes(f, m.index, 40);
    if (m.index >= h && COMPLEMENTO.test(v) && !FACULTA_A.test(v)) continue;
    const lado: Lado = /^(co)?arrendatari|^inquilin|^locatari/.test(m[0])
      ? 'arrendatario'
      : /^(empresa|prestador)/.test(m[0])
        ? 'tercero'
        : 'arrendador';
    r.push({ t: [m.index, m.index + m[0].length], lado });
  }
  return r;
}
/** El sujeto que gobierna la acción en i: el último antes o, si no hay, el primero después. */
function gobierna(ss: Sujeto[], i: number): Sujeto | null {
  let s: Sujeto | null = null;
  for (const x of ss) {
    if (x.t[0] >= i) return s ?? x;
    s = x;
  }
  return s;
}

// ── deposito (5.3.1) ──

const ROTULO = `(?!${S}(?:n|no|nro|numero)${S}[0-9])`; // «depósito N° 12» es un cuarto útil
const MESES = '(mes|meses|canon|canones|mensualidad*|arriendos?)';
const DEPOSITO = rx(
  tras(
    w('deposit*') + ROTULO,
    3,
    w('en dinero|en efectivo|(de|como|en) garantia*|reembolsabl*|equivalente*|que se (devolv|reembols|reintegr)*'),
  ),
  // «$1.500.000» son tres palabras plegadas («$1 500 000»): el dinero y los meses tienen su propia ventana
  tras(w('deposit*') + ROTULO, 4, w(`\\$*|pesos|suma*|millon*|(${UNO_A_ONCE}|doce|[0-9]{1,2}) ${MESES}`)),
  w('(entreg|pag|consign|constitu|dej|exig|cobr|solicit|requer)* ((un|una|el|la|como) )?(depositos?|caucion|cauciones)') + ROTULO,
  w(`${MESES} (de|como) deposit*|(a titulo|en calidad) de deposit*`),
  cerca(w('garantia*|caucion*'), 4, w('dinero|efectivo|\\$*|suma*|monetari*|consign*|pesos')),
  tras(w(`${MESES}|equivalente*`), 3, w('(en|como|a titulo de|en calidad de) (garantia*|respaldo|caucion)')),
  tras(w('(entreg|pag|consign|dej|otorg|constitu)*|dar|dara|daran'), 3, w(`${MESES} (de|en|como) garantia*`)),
  cerca(w(`([2-9]|1[0-9]|${DOS_A_DOCE}) (primer[oa]s )?(mes|canon|mensualidad)*`), 3, w('anticipad*|adelantad*|anticipo*')),
  cerca(w('anticip*'), 4, w('garantia*|respald*|deposit*')),
  cerca(w('(prenda|hipoteca|cdt)s?|pignor*'), 8, w('garantia*|respald*|caucion*|asegur*|cumplimiento')),
  w('(garantia|caucion)s? (real|reales|hipotecari*|prendari*)'),
  tras(w('cheque*'), 3, w('posfechad*|garantia*')),
);
/** Dinero que se entrega para devolverlo: «el equivalente a dos cánones, que se le devolverán». */
const DEVUELVE = rx(
  tras(w('equivalente*|suma*|\\$*'), 3, w('(que )?((se|le|les) ){0,2}((sera|seran) )?(devolv|devuelt|reembols|reintegr)*')),
);
/** … salvo lo pagado de más: «si paga una suma mayor, la diferencia se reintegrará». */
const SOBRANTE = rx(w('diferencia|exceso|excedente*|mayor|de mas'));

// ── mascotas (5.3.2) ──

const CRIA = rx(
  w(
    '(cria|crianza|reproduccion|venta|comercializacion) de (animales|mascotas|perros|gatos)|animales (silvestres|salvajes|exoticos|de granja)',
  ),
);
const ANIMAL = rx(w('mascota*|animal*|perr[oa]*|gat[oa]*|canino*|felino*'));
const RESTRINGE = rx(
  // «no está prohibida» no prohíbe
  `(?<!(?<![^ ])no${S}(?:(?:se|l[ao]|esta|estan|es|son|sera|seran|queda|quedan)${S}){0,2})` + w('prohib*'),
  w(
    'no (se )?(permit|admit|acept|autoriz)*|no (esta|estan|es|son|sera|seran) (permitid|admitid|aceptad|autorizad)*|' +
      'no podra* (tener|ingresar|mantener|alojar|albergar|permanecer|convivir|habitar|vivir)*|' +
      `se abstendra* de (tener|mantener|ingresar|alojar|albergar)*|(libre de|sin) ${BICHO}`,
  ),
  tras(w('no (tendra|tendran|mantendra|mantendran)'), 2, w(BICHO)),
  // condiciona: autorización, número, raza/tamaño, cobro
  w('previa autorizacion|autorizacion (previa|expresa|escrita)|con (el )?(permiso|visto bueno|consentimiento)'),
  tras(w('requier*|requerira*|necesit*|sujet[oa]s? a|condicionad[oa]s? a'), 3, w('autorizacion|permiso|visto bueno|consentimiento|aprobacion')),
  w('(ser|sean|seran|estar|esten|estaran) (previamente )?(autorizad|aprobad)*'),
  // el animal puede venir del título: «Mascotas» + «Solo se permite una por apartamento.»
  w(
    `(maximo|limite|hasta|solo|solamente|unicamente|(no )?mas de) (se (permit|admit|acept)* )?(de )?(un|una|dos|tres|[0-9]{1,3}) (${BICHO}|por|en cada|$)|` +
      `(un|una|uno) sol[oa] ${BICHO}`,
  ),
  // raza/tamaño/peso solo junto a quien restringe: «adecuado a su tamaño» o «perros de razas peligrosas» no condicionan
  cerca(w('(permit|admit|acept|autoriz|prohib|restring|limit)*|solo|solamente|unicamente|maximo|exclusivamente'), 4, w('razas?|tamanos?|pesos?')),
  w(`(recargo|sobrecosto|cuota|tarifa|canon|valor|suma|pago)* (adicional|extra|mensual)*|por cada ${BICHO}`),
  tras(w('\\$*|pesos'), 3, w('adicional*|extra*')), // «pagará $50.000 mensuales adicionales»
);
/** Lo que sigue a la restricción es una conducta («prohibido dejar excrementos», «no se permiten ruidos»), no la tenencia. */
const CONDUCTA =
  /^ {1,12}(?:(?:que|el|la|los|las|a) {1,12})?(?:dejar|botar|arrojar|abandonar|maltrat[a-z]{0,6}|excrementos?|heces|desechos?|residuos?|ruidos?|ladridos?|orin[a-z]{0,4})(?![^ ])/;
/** «EL ARRENDATARIO no permitirá (que / el ingreso de) sus mascotas…»: controla a sus animales. */
const SUS_BICHOS = /^(?: {1,12}[^ ]{1,30}){0,3}? {1,12}sus? {1,12}(?:mascota|animal|perr[oa]|gat[oa]|canin|felin)/;
const SIN_IMPORTAR = /(?<![^ ])(?:sin {1,12}importar|independientemente|cualquier[a-z]{0,2})(?![^ ])/;
const SANCIONA = rx(
  w(
    'causal*|dara lugar a (la )?terminacion|terminacion (del contrato|anticipada|inmediata)|dar por terminad*|podra* terminar*|desaloj*|restitucion (inmediata|del inmueble)',
  ),
  tras(w('(facult|habilit)*'), 3, w('(dar por )?termin*')),
);
const NO_ES_CAUSAL = rx(
  w('no (sera|es|constituye|constituira|dara lugar a) (causal|motivo)*|no (facult|habilit)*|por si sol[ao]'),
);

function mascotas(f: string, h: number): Tramo | null {
  const g = f.replace(CRIA, (m) => ' '.repeat(m.length)); // la cría/venta y los silvestres no son compañía
  const a = primero(ANIMAL, g);
  if (!a) return null;
  const p =
    primero(RESTRINGE, g, (m) => {
      const resto = g.slice(m.index + m[0].length, m.index + m[0].length + 80);
      return (
        CONDUCTA.test(resto) ||
        SIN_IMPORTAR.test(m[0]) ||
        (/^no +permitir/.test(m[0]) &&
          SUS_BICHOS.test(resto) &&
          gobierna(sujetos(g, h), m.index)?.lado === 'arrendatario')
      );
    }) ?? (hay(NO_ES_CAUSAL, g) ? null : primero(SANCIONA, g));
  return p && une(a, p);
}

// ── incremento (5.3.3, solo vivienda) ──

const CANON = rx(
  w('canon|canones|arriendos?|arrendamientos?|rentas?|precio mensual|mensualidad*|(valor|cuota) mensual(?! de( la)? administracion)'),
);
const SUBE = rx(w('increment*|reajust*|ajust*|actualiz*|aument*|alzas?|sub(e|ir|ira|iran)|indexa*'));
const FORMULA = rx(
  w(
    'ipc (mas|adicionad*|sumad*|incrementad*|[0-9]{1,2})|puntos? (adicional|porcentual)*|(superior|por encima|mayor) (al|del|que el) ipc|' +
      '(doble|triple|(dos|tres|[2-9]) veces) (del|el) ipc|salario minimo',
  ),
  tras(w('ipc'), 3, w('puntos?')), // «IPC + 3 puntos» («+» se pliega a espacio), «IPC sumado a dos puntos»
  w(`cada (${UNO_A_ONCE}|[1-9]|1[01])( [0-9]{1,2})? mes*|(dos|tres|cuatro|[2-9]) veces (al|por|cada) ano`),
  w(
    '(ajuste|reajuste|incremento|aumento|actualizacion) (semestral|trimestral|bimestral|mensual)|(semestral|trimestral|bimestral)mente|a criterio|a discrecion|unilateralmente',
  ),
  // «en el porcentaje que determine EL ARRENDADOR» (no «en la cuenta que indique EL ARRENDADOR»)
  tras(
    w('porcentaje|valor|monto|incremento|reajuste|aumento|ajuste|tasa'),
    2,
    w('que (determine|fije|decida|establezca|defina|disponga) (el|la) (arrendador*|propietari*|inmobiliaria)'),
  ),
);
// «8 %», «8%», «100,5 %» (→ «100 5 %»), «por ciento»; nunca el «%» suelto de un número ya juzgado
const PORCENTAJE = /(?<![^ ])(?<![0-9] {0,12})(?:([0-9]{1,4})(?: {1,3}([0-9]{1,3}))? {0,12})?(?:%|por {1,12}ciento(?![^ ]))/g;
// … seguido de «del IPC» (admite «cien por ciento (100 %) del IPC»)
const DEL_IPC = /^(?: {1,12}(?:[0-9%]{1,8}|por|ciento|cien)){0,4} {1,12}del {1,12}(?:ipc|indice)(?![^ ])/;
/** «por ciento» en letras por encima de cien: «ciento cincuenta», «doscientos», «mil». */
const MAS_DE_CIEN = /(?<![^ ])(?:[a-z]{0,6}cientos?|mil)(?![^ ])/;

function incremento(f: string): Tramo | null {
  const c = primero(CANON, f);
  const v = c && primero(SUBE, f);
  if (!c || !v) return null;
  const subes = inicios(SUBE, f);
  const x =
    primero(FORMULA, f) ??
    primero(PORCENTAJE, f, (m) => {
      // solo el % que sigue de cerca a la subida: «… y pagará intereses del 2 % mensual» no reajusta el canon
      if (!subes.some((s) => s < m.index && m.index - s <= 70)) return true;
      const fin = m.index + m[0].length;
      if (!DEL_IPC.test(f.slice(fin, fin + 80))) return false;
      if (m[1]) return Number(`${m[1]}.${m[2] ?? 0}`) <= 100;
      return !MAS_DE_CIEN.test(antes(f, m.index, 60).trim().split(/ +/).slice(-3).join(' '));
    });
  return x && une(c, v, x);
}

// ── fianza (5.3.4) ──

const FIANZA = rx(
  w(
    'cofianza|fianzas?|afianz*|subroga*|cashback|prima de vinculacion|(18|dieciocho)( 18)? (canones|meses|mensualidades)|' +
      '(seguro|poliza|amparo|garantia)s? (de|del) (arrendamiento|arriendo)s?|entidad(es)? garante*',
  ),
);
// «durante el arrendamiento» a 5 palabras de la «cobertura» de un seguro de hogar no es la fianza
const COBERTURA = rx(
  cerca(w('coberturas?'), 5, w('canon*|moras?')),
  cerca(w('coberturas?'), 3, w('arrendamiento*|arriendo*')),
  cerca(w('amparos?'), 3, w('canon*|moras?')),
);
const SEGURO = rx(
  w('(seguro|poliza)s? (de hogar|contra|de responsabilidad|todo riesgo|de incendio|(del|de) (inmueble|hogar|contenido|enseres|bienes))'),
);
// «Las cuotas de administración quedan amparadas»: cobertura sin nombrar la fianza.
// No lo es «cubiertos por EL ARRENDATARIO» (quién paga) ni «cubiertos con plástico».
const AMPARADO = rx(
  cerca(
    w('(amparad|cubiert)[oa]s?'),
    8,
    w('administracion|servicios|canon*|cuotas?|intereses|multas?|reparacion*|danos|perjuicios|sanciones|expensas'),
  ),
);
const PARTICIPIO = /(?<![^ ])(?:amparad|cubiert)[oa]s?(?![^ ])/;
const AGENTE =
  /^ {1,12}(?:por {1,12}(?:(?:el|la|los|las) {1,12})?(?:(?:co)?arrendatari|inquilin|locatari|arrendador|propietari|inmobiliaria)|con(?![^ ]))/;
function amparado(f: string): Tramo | null {
  return primero(AMPARADO, f, (m) => {
    const p = PARTICIPIO.exec(m[0]);
    const fin = m.index + (p ? p.index + p[0].length : 0);
    return !p || AGENTE.test(f.slice(fin, fin + 60));
  });
}
// «EL ARRENDATARIO no pagará la tarifa mensual», «La prima la pagará EL ARRENDADOR»:
// en este contrato la tarifa y la prima son las de la fianza (CUARTA). Las de los
// servicios, los seguros de hogar o el trabajo no.
const TARIFA_PRIMA = rx(w('tarifas?|primas?'));
const AJENA = rx(
  w(
    'servicio*|energia|luz|electric*|acueducto|alcantarillado|agua|gas|aseo|internet|television|tv|telefon*|celular*|' +
      'parqueadero*|administracion|transaccion*|pasarela*|bancari*|bancos?|datafono*|tarjetas?|transporte|mudanza|trasteo|' +
      'seguros?|polizas?|hogar|visitantes|navidad|nomina|salari*|vacaciones|materia',
  ),
);
function tarifaPrima(f: string): Tramo | null {
  return primero(TARIFA_PRIMA, f, (m) => hay(AJENA, f.slice(Math.max(0, m.index - 45), m.index + m[0].length + 45)));
}

// ── renuncia (5.3.5) ──

const RENUNCIA = rx(w('renunci*'));
const NO_RECLAMA = rx(
  tras(
    w('no podra*|no tendra derecho a|se obliga a no|se abstendra de|no (presentara|interpondra|formulara|iniciara|instaurara)n?'),
    2,
    w('reclam*|exigir*|demand*|interponer*|acudir*|solicitar (la )?(indemnizacion|reparacion)*'),
  ),
  w('no tendra* derecho (a|al) ((ningun|ninguna|alguna|la|el) )?(indemniz*|reclam*|prorroga*|preaviso*|compensacion*)'),
);
const LIBERA = '(toda|cualquier) responsabilidad|vicios?|reparaciones necesarias|goce|humedad*|filtracion*';
const EXONERA = rx(
  tras(tras(w('(exoner|exim|liber)*'), 3, w('arrendadora?|propietari[oa]')), 6, w(LIBERA)),
  // «EL ARRENDADOR queda exonerado de…», «no será responsable por…»: el arrendador va antes del verbo
  tras(
    tras(w('arrendadora?|propietari[oa]'), 4, w('(exonerad|eximid|liberad)*|no (sera|es) responsables?|no respondera*')),
    6,
    w(LIBERA),
  ),
  tras(
    tras(w('reparacion*'), 3, w('necesari[oa]s')),
    6,
    w('(a cargo|por cuenta|a costa|a expensas) (del|de el|de) (arrendatari*|inquilin*)'),
  ),
);
// «EL ARRENDATARIO asumirá (pagará, hará) las reparaciones necesarias»: son del
// arrendador (Ley 820, art. 8, num. 2). Solo cuando quien las asume es el arrendatario.
const NECESARIAS = tras(w('reparacion*|arreglos?'), 2, w('necesari[oa]s'));
const ASUME = w('(asum|pag|coste|sufrag|realiz|realic|efectu|ejecut)*|hacer|hara|haran|hace|hacen|correr* con');
const ASUME_NECESARIAS = rx(tras(ASUME, 3, NECESARIAS), tras(NECESARIAS, 3, ASUME));
const ARRENDADOR = rx(w('arrendadora?'));
const ARRENDATARIO = rx(w('arrendatari*|inquilin*|locatari*|las partes'));
const REQUERIMIENTOS = rx(w('requerimient*|constitucion en mora|reconvencion*'));
const DERECHOS = rx(
  w(
    'preaviso*|indemniz*|prorrog*|reparacion*|goce|vicio*|acudir|reclam*|demand*|derecho*|restitu*|devolucion*|terminacion*|recurso*|accion*|juez|jueces|tutela*',
  ),
);
const MEJORAS = rx(w('mejoras?'));

function renuncia(f: string, h: number): Tramo | null {
  // Precalculado por segmento: las excusas miran antes/después de cada disparo en O(1).
  const ad = primero(ARRENDADOR, f);
  const at = primero(ARRENDATARIO, f);
  const req = ultimo(REQUERIMIENTOS, f);
  const der = ultimo(DERECHOS, f);
  /** El texto previo nombra al arrendador y no al arrendatario ni a «las partes». */
  const delArrendador = (i: number) => !!ad && ad[1] <= i && !(at && at[1] <= i);
  /** Después de «renunci*»: requerimientos/mora/reconvención y ningún derecho del arrendatario. */
  const soloRequerimientos = (j: number) => req >= j && der < j;
  // «no tendrá derecho a indemnización por las mejoras» es el régimen de mejoras, no una renuncia
  const mejoras = hay(MEJORAS, f);
  return (
    primero(RENUNCIA, f, (m) => delArrendador(m.index) || soloRequerimientos(m.index + m[0].length)) ??
    primero(NO_RECLAMA, f, (m) => delArrendador(m.index) || (mejoras && /derecho/.test(m[0]))) ??
    primero(EXONERA, f) ??
    primero(ASUME_NECESARIAS, f, (m) => gobierna(sujetos(f, h), m.index)?.lado !== 'arrendatario')
  );
}

// ── terminacion (5.3.6, solo vivienda) ──

const TERMINACION = rx(
  w('no (se )?(prorrog|renova)*|improrrogabl*|sin (derecho a )?prorroga*|preaviso*|desahucio*'),
  w(
    'no (sera|es|seran|son) (prorrogabl|renovabl)*|no (tendra|tendran|habra|admite|admitira) (lugar a )?(prorroga|renovacion)*|' +
      'sin que (haya|exista) lugar a (prorroga|renovacion)*',
  ),
  tras(tras(w('(prorroga|renovacion)*'), 6, w('solo|unicamente|previa')), 3, w('autoriz*|acuerdo|aceptacion|decision')),
  tras(
    w('termin*'),
    3,
    w('automatic*|de pleno derecho|inmediat*|en cualquier momento|sin (causa|preaviso|indemnizacion|justa causa)'),
  ),
  w('(podra|podran|queda facultad* para) (dar por )?termin*|(el|este|presente) contrato (se )?terminaran?'),
  // el preaviso sin la palabra: «avisar por escrito con seis (6) meses de anticipación» (solo meses: «dos días de anticipación» es una visita)
  tras(w('(avis|notific|inform|comunic)*'), 6, w(`(${NUMERO})( [0-9]{1,4})? mes(es)? de (anticipacion|antelacion)`)),
  w(`(anticipacion|antelacion)( minima)? (de|no (menor|inferior) (a|de)) (${NUMERO})( [0-9]{1,4})? mes(es)?`),
);
// «término»/«plazo» solo con «del contrato»/«inicial»: «en el término de tres días» es un plazo, no la vigencia
const VIGENCIA = rx(
  tras(
    w(
      '(vigencia|duracion)( inicial)?( del contrato)? (sera|es|de)|(termino|plazo) (inicial( del contrato)?|del contrato) (sera|es|de)|' +
        '(contrato|arrendamiento) durara',
    ),
    2,
    w(`(${NUMERO})( [0-9]{1,4})? (mes|ano|dia)*`),
  ),
);
/** «un seguro … con vigencia de un año»: la vigencia de otra cosa. */
const OTRA_VIGENCIA = /(?<![^ ])(?:seguro|poliza|garantia|licencia)s?(?![^ ])|(?<![^ ])con(?: {1,12}(?:una|la))? {1,12}$/;
const INDEMNIZA = rx(cerca(w('indemniz*'), 6, w('terminacion*')));
/** «indemnizará (al arrendador por) los daños»: repara daños, no indemniza la terminación. */
const INDEMNIZA_DANOS = /^indemnizar[a-z]{0,3} {1,12}(?:[^ ]{1,30} {1,12}){0,3}?(?:danos|deterioros|desperfectos)(?![^ ])/;
const CAUSAL = rx(
  tras(w('causal(es)?'), 3, w('terminacion')),
  w('dara lugar a (la )?terminacion|sera (justa )?causa (de|para)'),
  `(?<!(?<![^ ])(?:a|por)${S})` + w('(justa )?causa( justa)? (de|para) (la )?(dar por )?termin*'),
  w('motivo (de|para) (la )?(dar por )?termin*|(tendra|tendran|tiene|tienen) (el )?derecho a (dar por )?termin*'),
  tras(w('(facult|habilit)*'), 3, w('(dar por )?termin*')),
);
const NO_SERA = rx(w('no (sera|es|constituye|constituira|dara lugar)'));
const POR_SI_SOLO = rx(w('por si sol[ao]'));

function terminacion(f: string): Tramo | null {
  return (
    primero(TERMINACION, f) ??
    primero(VIGENCIA, f, (m) => OTRA_VIGENCIA.test(antes(f, m.index, 40))) ??
    primero(INDEMNIZA, f, (m) => INDEMNIZA_DANOS.test(f.slice(f.indexOf('indemniz', m.index), m.index + m[0].length + 60))) ??
    (hay(POR_SI_SOLO, f)
      ? null
      : primero(CAUSAL, f, (m) => {
          const v = antes(f, m.index, 30);
          return hay(NO_SERA, v) || /(?<![^ ])no {1,12}$/.test(v);
        }))
  );
}

// ── tenencia (5.3.7) ──

const ACCION = rx(
  tras(
    w('(cambi|reemplaz|desactiv|inhabilit)*|bloque[ao]*'),
    2,
    w('guardas?|chapas?|cerraduras?|llaves?|claves?( de acceso)?|tarjetas?( de acceso)?|codigos? de acceso'),
  ),
  tras(w('(retir|reten)*|sacar|disponer de|embarg*'), 3, w('bienes|enseres|muebles|pertenencias|objetos')),
  tras(w('(cort|suspend|desconect|interrump)*'), 3, w('servicio*|agua|energia|luz|gas|internet')),
  w('desaloj*|lanzamiento'),
  tras(w('recuper*|tomar|retomar'), 2, w('tenencia|posesion|inmueble')),
  tras(w('(imped|restring)*|bloque[ao]*'), 2, w('acceso|ingreso|entrada')),
);
const SIN_JUEZ = rx(
  w('sin (necesidad de )?(orden|autorizacion|intervencion|proceso) (judicial|de autoridad|de juez)'),
  tras(w('extrajudicial*'), 3, w('desaloj*|restitu*|recuper*|entrega')),
  w(
    'vias? de hecho|por (sus|su) propi[oa]s? (medios|mano|cuenta)|desalojo (inmediato|directo|administrativo|policivo)|' +
      'se procedera a (desalojar|cambiar|retirar|cortar|suspender)',
  ),
);
const VIA_JUDICIAL = rx(
  w('previa orden judicial|mediante (el )?proceso|ante (un |el )?juez|(articulo|art) 384|proceso de restitucion'),
);
const NO_PODRA = /(?<![^ ])no {1,12}podra[^ ]{0,2} {1,12}(?:[^ ]{1,30} {1,12})?$/;
const SIN = /(?<![^ ])sin(?![^ ])/;
const MORA = rx(w('mora|no pag*|falta de pago|impago*|incumpl*'));
const PASIVA = /(?<![^ ])se {1,12}$/;

/**
 * La acción cuenta si la gobierna el lado del arrendador; si no hay sujeto, si
 * va en pasiva refleja («se cambiarán las guardas»); con mora de por medio,
 * aunque el sujeto sea el arrendatario («si EL ARRENDATARIO no paga, podrá
 * cambiar las guardas»). La empresa de servicios no es el arrendador.
 */
function tenencia(f: string, h: number): Tramo | null {
  const sinJuez = primero(SIN_JUEZ, f);
  if (sinJuez) return sinJuez;
  // «ante un juez» excusa; «sin necesidad de acudir ante un juez» no
  if (primero(VIA_JUDICIAL, f, (m) => SIN.test(antes(f, m.index, 40)))) return null;
  const ss = sujetos(f, h);
  const mora = hay(MORA, f);
  const a = primero(ACCION, f, (m) => {
    if (NO_PODRA.test(antes(f, m.index, 60))) return true;
    const s = gobierna(ss, m.index);
    if (s?.lado === 'tercero') return true;
    if (s?.lado === 'arrendador' || mora) return false;
    return !!s || !(PASIVA.test(antes(f, m.index, 20)) || /^[^ ]*se(?![^ ])/.test(m[0]));
  });
  const s = a && gobierna(ss, a[0]);
  return a && (s?.lado === 'arrendador' ? une(s.t, a) : a);
}

// ── modifica_contrato (5.1.3) ──

const OBJETO = 'clausula*|paragrafo*|lo (pactado|estipulado|dispuesto|previsto)|(el|este|presente) contrato|numeral*|literal*';
const SIN_EFECTO =
  '(deja|queda)* sin efecto|no (se )?aplicar*|se (entiende|entender)* no escrit*|no (sera|seran|es|son) (exigibl|aplicabl)*';
const MODIFICA = rx(
  tras(w(`(modific|derog|reemplaz|sustitu|suprim|anul)*|exclui*|excluy*|exclusion|sin efecto|${SIN_EFECTO}`), 6, w(OBJETO)),
);
/** «… de esta cláusula»: la cláusula adicional se refiere a sí misma, no al contrato. */
const A_SI_MISMA = /(?<![^ ])(?:esta|presente) {1,12}clausula[^ ]*$/;
// «La cláusula de restitución queda sin efecto»: el objeto va antes del verbo
const QUEDA_SIN_EFECTO = rx(tras(w(OBJETO), 6, w(SIN_EFECTO)));
const PREVALECE = rx(
  tras(w('(esta|la presente) clausula'), 4, w('prevalec*|prima* sobre|se aplicara de preferencia')),
  tras(w('(prevalec|prima)* sobre'), 3, w('contrato|clausula*|lo pactado')),
  tras(w('prevalec*|primara|primaran'), 3, w('lo aqui|(esta|la presente) clausula')),
  tras(w('contradiccion*|conflicto*|discrepancia*|incompatibilidad*'), 8, w('lo aqui|(esta|la presente) clausula')),
);
/**
 * «durante (la vigencia de) este contrato», «conforme a lo dispuesto en…»
 * dicen cuándo o según qué, no qué se modifica: se tapan con «x» (la misma
 * longitud y las mismas palabras, para no juntar lo que venga a los lados).
 */
const NEUTRO = rx(
  w(
    '(durante|mientras dure|en vigencia de) (la vigencia (de|del) )?((el|este|presente|dicho) ){0,2}contrato|' +
      '(conforme a|de acuerdo con|segun|de conformidad con|en los terminos de) lo (dispuesto|previsto|pactado|estipulado|establecido)',
  ),
);
const POR_ESCRITO = rx(w('por escrito|debera constar|constara|otrosi*'));
const COSAS = rx(
  w(
    'inmueble|bien|vivienda|fachada|instalacion*|redes|estructura|pared*|pintura|apartamento|casa|local|locativ*|muros?|' +
      'cocina*|bano*|pisos?|puertas?|ventanas?|bombill*|vidrios?',
  ),
);
const NO_ANTES =
  /(?<![^ ])no {1,12}(?:se {1,12})?(?:(?:podra|debera)[^ ]{0,2} {1,12})?(?:(?:hacer|hara|haran|realizar|realizara|realizaran|efectuar|efectuara|efectuaran) {1,12})?$/;
const ESTA_ANTES = /(?<![^ ])(?:esta|presente) {1,12}$/;

function modificaContrato(f0: string): Tramo | null {
  const f = f0.replace(NEUTRO, (m) => m.replace(/[^ ]/g, 'x'));
  const escrito = hay(POR_ESCRITO, f);
  return (
    (escrito
      ? null
      : primero(MODIFICA, f, (m) => hay(COSAS, m[0]) || A_SI_MISMA.test(m[0]) || NO_ANTES.test(antes(f, m.index, 40)))) ??
    (escrito ? null : primero(QUEDA_SIN_EFECTO, f, (m) => hay(COSAS, m[0]) || ESTA_ANTES.test(antes(f, m.index, 20)))) ??
    primero(PREVALECE, f)
  );
}

// ── Reglas por destinación ──

export interface Regla {
  hallazgo: Entrada;
  /** Tramo que dispara dentro del segmento plegado (con el título delante), o null; `titulo` = largo del título al inicio. */
  detectar: (segmento: string, titulo: number) => Tramo | null;
}

/** Fase 2 agrega `comercial` (mismos detectores, mensajes comerciales, art. 524 C.Co.). */
export const REGLAS: Partial<Record<Destinacion, Regla[]>> = {
  vivienda: [
    {
      hallazgo: CATALOGO.deposito,
      detectar: (f) => primero(DEPOSITO, f) ?? primero(DEVUELVE, f, (m) => hay(SOBRANTE, m[0])),
    },
    { hallazgo: CATALOGO.mascotas, detectar: mascotas },
    { hallazgo: CATALOGO.incremento, detectar: incremento },
    {
      hallazgo: CATALOGO.fianza,
      detectar: (f) =>
        primero(FIANZA, f) ?? (hay(SEGURO, f) ? null : (primero(COBERTURA, f) ?? amparado(f))) ?? tarifaPrima(f),
    },
    { hallazgo: CATALOGO.renuncia, detectar: renuncia },
    { hallazgo: CATALOGO.terminacion, detectar: terminacion },
    { hallazgo: CATALOGO.tenencia, detectar: tenencia },
    { hallazgo: CATALOGO.modifica_contrato, detectar: modificaContrato },
  ],
};

// ── Estructurales (toda destinación) ──

// \p{M}: tras NFC al español no le sobra ninguna marca (CGJ, selectores de variación…)
const RARO = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{M}]|(?!\p{Script=Latin})\p{L}|\p{Extended_Pictographic}/u;
/**
 * Letra o dígito no ASCII que no pliega a UNA sola [a-z0-9]: «ı», «ɩ», «ø»,
 * «ß», «ﬁ»… (latinas que el plegado deja en blanco o parte en dos y así
 * esconden «prohíbe» o «depósito»). Á, ñ, ü, ª, º pliegan bien y pasan.
 */
function ajena(s: string): RegExpExecArray | null {
  const re = /(?![a-zA-Z0-9])[\p{L}\p{Nd}]/gu;
  for (let m = re.exec(s); m; m = re.exec(s))
    if (!/^[a-z0-9]$/.test(m[0].normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase())) return m;
  return null;
}
const CORCHETES = /\[\[|\]\]/;
const CITA = rx(
  w(
    '(clausula|paragrafo)s? ([0-9]{1,2}|[ivxlc]{1,6}|(primer|segund|tercer|cuart|quint|sext|septim|octav|noven|decim|vigesim|trigesim)*)',
  ),
);

/** Extiende [i, j) a la "palabra" que lo contiene (sin espacios), hasta 200. */
function alrededor(s: string, i: number, j: number, palabra = /\S/): Tramo {
  while (i > 0 && j - i < 200 && palabra.test(s[i - 1])) i--;
  while (j < s.length && j - i < 200 && palabra.test(s[j])) j++;
  return [i, j];
}

/** Lo que el motor no imprime (MARCADOR solo corre en modo final: se ataja al guardar). */
function noImprimible(c: { titulo: string; texto: string }, biblioteca: boolean): Tramo | null {
  const plano = `${c.titulo}. ${c.texto}`;
  // En la biblioteca un [[campo]] válido se tolera: se miran sus letras, no sus corchetes.
  const s = biblioteca ? `${c.titulo}. ${c.texto.replace(CAMPO, (_m, n: string) => `  ${n}  `)}` : plano;
  const m = MARCADOR.exec(s) ?? RARO.exec(s) ?? ajena(s) ?? CORCHETES.exec(s);
  if (m) return alrededor(plano, m.index, m.index + m[0].length);
  // El motor imprime el título en MAYÚSCULAS: «no aplica» sale «NO APLICA» y
  // falla en modo final. mayus() puede cambiar el largo (ß → SS): va el título entero.
  if (MARCADOR.test(mayus(c.titulo))) return [0, c.titulo.length];
  const cs = biblioteca ? campos(c.texto) : [];
  if (cs.length <= MAX_CAMPOS) return null;
  const sobra = `[[${cs[MAX_CAMPOS]}]]`;
  const i = plano.indexOf(sobra, c.titulo.length + 2);
  return [i, i + sobra.length];
}

/** Segmentos (oraciones y «;») del texto ORIGINAL: «art. 384» y «$1.500.000» no cortan. */
const CORTE = /[.!?](?=\s+[\p{Lu}¿¡«"(]|\s*$)|;/gu;
function segmentos(s: string): Tramo[] {
  const r: Tramo[] = [];
  let ini = 0;
  for (const m of s.matchAll(CORTE)) {
    const fin = m.index + m[0].length;
    r.push([ini, fin]);
    ini = fin;
  }
  if (ini < s.length) r.push([ini, s.length]);
  return r;
}

/**
 * Valida una cláusula (título + texto ya con los campos llenos, salvo en la
 * biblioteca). `hallazgos` bloquean; `avisos` (cita por número) no.
 * Destinación sin reglas → 500 CLAUSULAS_SIN_REGLAS (fail-closed).
 */
export function validarClausula(
  original: { titulo: string; texto: string },
  o: OpcionesValidacion,
): { hallazgos: Hallazgo[]; avisos: Hallazgo[] } {
  const reglas = REGLAS[o.destinacion];
  if (!reglas)
    throw new AppError(
      500,
      'CLAUSULAS_SIN_REGLAS',
      `No hay reglas de cláusulas adicionales para la destinación «${o.destinacion}».`,
    );
  // NFD («o» + tilde suelta) partiría «depósito» en «depo sito»: se juzga la forma compuesta
  const c = { titulo: original.titulo.normalize('NFC'), texto: original.texto.normalize('NFC') };
  const plano = `${c.titulo}. ${c.texto}`;
  const plegado = plegar(plano);
  const hallazgo = (e: Entrada, [i, j]: Tramo): Hallazgo => ({
    ...e,
    fragmento: plano.slice(i, j).slice(0, 200),
    fuente: 'reglas',
  });

  const hallazgos: Hallazgo[] = [];
  const imp = noImprimible(c, !!o.biblioteca);
  if (imp) hallazgos.push(hallazgo(CATALOGO.no_imprimible, imp));
  // superconjunto de lo que ataja el motor (/coarrendatari/i sobre lo impreso)
  const co = o.sinCoarrendatario ? /coarrendatari/.exec(plegado) : null;
  if (co) hallazgos.push(hallazgo(CATALOGO.coarrendatario, alrededor(plegado, co.index, co.index + 13, /[^ ]/)));

  // Cada segmento del texto se juzga con el título delante: «Mascotas» + «Está
  // prohibida su tenencia». Un tramo que cae en el título conserva su posición;
  // el que empieza en el título y acaba en el texto es un corte literal de ambos.
  const h = c.titulo.length + 1; // título + «.»
  const titulo = plegado.slice(0, h);
  const segs = segmentos(plano);
  for (const r of reglas)
    for (const [a, b] of segs) {
      const pegado = a >= h;
      const t = pegado ? r.detectar(titulo + plegado.slice(a, b), h) : r.detectar(plegado.slice(a, b), Math.max(0, h - 1 - a));
      if (t) {
        const aqui = (k: number) => (!pegado ? a + k : k < h ? k : a + k - h);
        hallazgos.push(hallazgo(r.hallazgo, [aqui(t[0]), aqui(t[1])]));
        break;
      }
    }

  const cita = primero(CITA, plegado);
  return { hallazgos, avisos: cita ? [hallazgo(CATALOGO.cita_numero, cita)] : [] };
}
