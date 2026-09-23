/**
 * Formatos de los campos del motor de contratos V3 (Entrega 2, diseño §4.1).
 *
 * Todo es puro y en es-CO. El motor aplica `FORMATOS[fmt].fn` a `{fmt:campo}`
 * y el check de coherencia lee de vuelta la cifra impresa con `inverso`
 * (solo los formatos numéricos que pueden llevar una cifra del resumen).
 */

import { apocopar, formatearPesos, numeroALetras, numeroAPesosLetras } from '@/lib/numerosEnLetras';

const U = ['', 'primer', 'segund', 'tercer', 'cuart', 'quint', 'sext', 'séptim', 'octav', 'noven'];
const D = ['', 'décim', 'vigésim', 'trigésim', 'cuadragésim', 'quincuagésim'];

/**
 * Ordinal en letras, como lo escribe el Word: 11 → "décima primera".
 * `g = 'o'` para los parágrafos ("PARÁGRAFO PRIMERO"). Solo 1..59.
 */
export function ordinal(n: number, g: 'a' | 'o' = 'a'): string {
  if (!Number.isInteger(n) || n < 1 || n > 59) throw new RangeError(`Ordinal fuera de rango: ${n}`);
  return [D[Math.floor(n / 10)], U[n % 10]].filter(Boolean).map((r) => r + g).join(' ');
}

export const mayus = (s: string) => s.toLocaleUpperCase('es-CO');
export const titulo = (s: string) => s.replace(/(^|\s)\p{Ll}/gu, mayus);

// ── Fechas: siempre 'YYYY-MM-DD' sin hora, para no correr el día por zona ──

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

const diasDelMes = (anio: number, mes: number) => new Date(Date.UTC(anio, mes, 0)).getUTCDate();
const dos = (n: number) => String(n).padStart(2, '0');

function fecha(iso: string): { anio: number; mes: number; dia: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const [anio, mes, dia] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  if (!m || mes < 1 || mes > 12 || dia < 1 || dia > diasDelMes(anio, mes)) {
    throw new RangeError(`Fecha inválida (se espera AAAA-MM-DD): ${iso}`);
  }
  return { anio, mes, dia };
}

/**
 * Art. 67 C.C.: el primero y el último día de un plazo de meses llevan el
 * mismo número; si el mes de llegada no lo tiene, el último día del mes.
 * 2026-01-31 + 1 → 2026-02-28; 2026-10-01 + 12 → 2027-10-01.
 */
export function sumarMeses(iso: string, meses: number): string {
  if (!Number.isInteger(meses)) throw new RangeError(`Meses no enteros: ${meses}`);
  const { anio, mes, dia } = fecha(iso);
  const t = anio * 12 + (mes - 1) + meses;
  const [a, m] = [Math.floor(t / 12), (t % 12) + 1];
  return `${a}-${dos(m)}-${dos(Math.min(dia, diasDelMes(a, m)))}`;
}

/**
 * Período vigente de un contrato que se prorroga "en iguales condiciones y por
 * el mismo término inicial" (cláusula de PRÓRROGAS): el primero cuyo
 * vencimiento no ha pasado. Siempre desde el inicio con múltiplos del término,
 * nunca encadenando: el recorte a fin de mes volvería un 31 en 28 para siempre.
 * 2026-01-31, 1 mes, hoy 2026-03-15 → { n: 2, desde: 2026-02-28, hasta: 2026-03-31 }.
 */
export function periodoVigente(fechaInicio: string, meses: number, hoy: string) {
  if (!Number.isInteger(meses) || meses < 1) throw new RangeError(`Término inválido: ${meses}`);
  fecha(hoy);
  let n = 1;
  while (sumarMeses(fechaInicio, n * meses) < hoy) n++;
  return { n, desde: sumarMeses(fechaInicio, (n - 1) * meses), hasta: sumarMeses(fechaInicio, n * meses), prorrogas: n - 1 };
}

/**
 * Para listados y tableros, el "fin" real de un contrato V3: vigente, el del
 * período en curso (se prorroga solo); terminado, el día de la terminación. No
 * `fecha_fin`, que es el término inicial congelado. Las demás filas pasan igual.
 */
export function conFinVigente<
  T extends {
    estado?: string;
    fecha_inicio: string | null;
    fecha_fin: string | null;
    destinacion?: string | null;
    duracion_meses?: number | null;
    fecha_terminacion?: string | null;
  },
>(rows: T[], hoy = fechaBogota(new Date())): T[] {
  return rows.map((r) => {
    if (!r.destinacion) return r;
    if (r.estado === 'vigente' && r.fecha_inicio && r.duracion_meses)
      return { ...r, fecha_fin: periodoVigente(r.fecha_inicio, r.duracion_meses, hoy).hasta };
    if (r.estado === 'finalizado' && r.fecha_terminacion) return { ...r, fecha_fin: fechaBogota(r.fecha_terminacion) };
    return r;
  });
}

/**
 * Día calendario (AAAA-MM-DD) de un instante en Bogotá: UTC−5 todo el año, sin
 * horario de verano. 2026-07-24T00:30Z → '2026-07-23'.
 */
export function fechaBogota(d: Date | string): string {
  return new Date(new Date(d).getTime() - 5 * 3_600_000).toISOString().slice(0, 10);
}

// ── Números ──

/** "2,5" (es-CO, hasta 2 decimales). */
const pct = (n: number) => n.toLocaleString('es-CO', { maximumFractionDigits: 2 });

/** "dos coma cinco", "dos coma cero cinco" (2,05). Sin apócope: va antes de "por ciento". */
function pctLetras(n: number): string {
  const [entero, dec = ''] = n.toFixed(2).replace(/0+$/, '').split('.');
  const letras = numeroALetras(Number(entero));
  if (!dec) return letras;
  return `${letras} coma ${dec.startsWith('0') ? 'cero ' : ''}${numeroALetras(Number(dec))}`;
}

/** Lee de vuelta un número es-CO ("2.500.000", "2,5"); NaN si no tiene esa forma exacta. */
const leer = (re: RegExp) => (s: string) =>
  re.test(s) ? Number(s.replace(/\./g, '').replace(',', '.')) : NaN;

const letras = (n: number) => apocopar(numeroALetras(n));

// ── Documentos ──

const DOC: Record<string, [corto: string, largo: string]> = {
  cc: ['C.C.', 'cédula de ciudadanía'],
  ce: ['C.E.', 'cédula de extranjería'],
  pasaporte: ['Pasaporte', 'pasaporte'],
  ti: ['T.I.', 'tarjeta de identidad'],
  nit: ['NIT', 'NIT'],
};

function doc(tipo: string): [string, string] {
  if (!Object.hasOwn(DOC, tipo)) throw new RangeError(`Tipo de documento desconocido: ${tipo}`);
  return DOC[tipo];
}

type Formato = { tipo: 'numero' | 'fecha' | 'texto'; fn: (v: never) => string; inverso?: (s: string) => number };

/**
 * `tipo` es el tipo de campo que acepta cada formato (el parser rechaza el
 * resto). Sin prototipo: `{toString:canon}` no debe pasar por un formato.
 */
export const FORMATOS: Record<string, Formato> = Object.assign(Object.create(null) as Record<string, Formato>, {
  pesos: { tipo: 'numero', fn: formatearPesos, inverso: leer(/^\d{1,3}(\.\d{3})*$/) },
  pesosLetras: { tipo: 'numero', fn: numeroAPesosLetras },
  pct: { tipo: 'numero', fn: pct, inverso: leer(/^\d{1,3}(\.\d{3})*(,\d{1,2})?$/) },
  pctLetras: { tipo: 'numero', fn: pctLetras },
  letras: { tipo: 'numero', fn: letras },
  meses: { tipo: 'numero', fn: (n: number) => `${letras(n)} (${n}) ${n === 1 ? 'mes' : 'meses'}` },
  fecha: {
    tipo: 'fecha',
    fn: (iso: string) => {
      const f = fecha(iso);
      return `${f.dia} de ${MESES[f.mes - 1]} de ${f.anio}`;
    },
  },
  dia: { tipo: 'fecha', fn: (iso: string) => String(fecha(iso).dia) },
  // dd/mm/aaaa del cuadro del Anexo (Entrega 5 §4.4): día y mes a dos dígitos
  dd2: { tipo: 'fecha', fn: (iso: string) => dos(fecha(iso).dia) },
  mm2: { tipo: 'fecha', fn: (iso: string) => dos(fecha(iso).mes) },
  mes: { tipo: 'fecha', fn: (iso: string) => MESES[fecha(iso).mes - 1] },
  anio: { tipo: 'fecha', fn: (iso: string) => String(fecha(iso).anio) },
  doc: { tipo: 'texto', fn: (t: string) => doc(t)[0] },
  docLargo: { tipo: 'texto', fn: (t: string) => doc(t)[1] },
} satisfies Record<string, Formato>);
