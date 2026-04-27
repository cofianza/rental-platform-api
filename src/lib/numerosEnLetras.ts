/**
 * Convierte numeros enteros a letras en espanol (Colombia).
 *
 * Soporta hasta 999.999.999 (suficiente para canones, duraciones y
 * afianzamiento). Para montos en pesos colombianos suele querer la
 * cadena con sufijo "PESOS M/CTE" — eso lo agrega `numeroAPesosLetras`.
 *
 * Casos: 0 → "cero", 1 → "uno", 21 → "veintiuno", 1000000 → "un millón".
 */

const UNIDADES = [
  '', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve',
];

const ESPECIALES_10_15 = [
  'diez', 'once', 'doce', 'trece', 'catorce', 'quince',
];

const DECENAS = [
  '', '', 'veinte', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa',
];

const CENTENAS = [
  '', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos',
  'seiscientos', 'setecientos', 'ochocientos', 'novecientos',
];

function unidadesYDecenas(n: number): string {
  if (n < 10) return UNIDADES[n];
  if (n < 16) return ESPECIALES_10_15[n - 10];
  if (n < 20) return `dieci${UNIDADES[n - 10]}`;
  if (n < 30) {
    if (n === 20) return 'veinte';
    return `veinti${UNIDADES[n - 20]}`;
  }
  if (n % 10 === 0) return DECENAS[Math.floor(n / 10)];
  return `${DECENAS[Math.floor(n / 10)]} y ${UNIDADES[n % 10]}`;
}

function centenas(n: number): string {
  if (n === 0) return '';
  if (n === 100) return 'cien';
  const c = Math.floor(n / 100);
  const resto = n % 100;
  if (c === 0) return unidadesYDecenas(resto);
  if (resto === 0) return CENTENAS[c];
  return `${CENTENAS[c]} ${unidadesYDecenas(resto)}`;
}

function miles(n: number): string {
  if (n < 1000) return centenas(n);
  const m = Math.floor(n / 1000);
  const resto = n % 1000;
  let prefijo: string;
  if (m === 1) {
    prefijo = 'mil';
  } else {
    prefijo = `${centenas(m).replace(/\buno\b/g, 'un')} mil`;
  }
  if (resto === 0) return prefijo;
  return `${prefijo} ${centenas(resto)}`;
}

export function numeroALetras(n: number): string {
  if (!Number.isFinite(n)) return '';
  const entero = Math.floor(Math.abs(n));
  if (entero === 0) return 'cero';

  if (entero < 1_000_000) return miles(entero);

  const millones = Math.floor(entero / 1_000_000);
  const resto = entero % 1_000_000;
  const prefijo = millones === 1 ? 'un millón' : `${miles(millones).replace(/\buno\b/g, 'un')} millones`;
  if (resto === 0) return prefijo;
  return `${prefijo} ${miles(resto)}`;
}

/**
 * Para canon/afianzamiento: "$80.000" → "OCHENTA MIL PESOS M/CTE"
 */
export function numeroAPesosLetras(n: number): string {
  return `${numeroALetras(n).toUpperCase()} PESOS M/CTE`;
}

/**
 * Formato visual con separador de miles colombiano (punto): 80000 → "80.000"
 */
export function formatearPesos(n: number): string {
  return new Intl.NumberFormat('es-CO', {
    maximumFractionDigits: 0,
  }).format(Math.round(n));
}
