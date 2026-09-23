/**
 * Días hábiles en Colombia: lunes a viernes que no son festivo. Puro, con
 * fechas 'AAAA-MM-DD' (día calendario, sin hora).
 *
 * Festivos: los fijos, los que la Ley 51 de 1983 («Ley Emiliani») pasa al lunes
 * siguiente y los que dependen de la Pascua (Jueves y Viernes Santo, Ascensión,
 * Corpus Christi y Sagrado Corazón, estos tres ya trasladados al lunes).
 * Los de estudios.service y calibracion.service (diasHabilesTranscurridos,
 * horasHabilesEntre) siguen contando los festivos como hábiles.
 */

const DIA_MS = 86_400_000;
const utc = (a: number, m: number, d: number) => new Date(Date.UTC(a, m - 1, d));
const iso = (d: Date) => d.toISOString().slice(0, 10);
const mas = (d: Date, dias: number) => new Date(d.getTime() + dias * DIA_MS);
/** El mismo día si es lunes; si no, el lunes siguiente (Ley 51 de 1983). */
const alLunes = (d: Date) => mas(d, (8 - d.getUTCDay()) % 7);

/** Domingo de Pascua (algoritmo gregoriano anónimo: Meeus/Jones/Butcher). */
function pascua(anio: number): Date {
  const a = anio % 19;
  const b = Math.floor(anio / 100);
  const c = anio % 100;
  const h = (19 * a + b - Math.floor(b / 4) - Math.floor((b - Math.floor((b + 8) / 25) + 1) / 3) + 15) % 30;
  const l = (32 + 2 * (b % 4) + 2 * Math.floor(c / 4) - h - (c % 4)) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const n = h + l - 7 * m + 114;
  return utc(anio, Math.floor(n / 31), (n % 31) + 1);
}

const cache = new Map<number, Set<string>>();

/** Los 18 festivos nacionales del año, como 'AAAA-MM-DD'. */
export function festivosColombia(anio: number): Set<string> {
  let f = cache.get(anio);
  if (!f) {
    const p = pascua(anio);
    const trasladables: Array<[number, number]> = [[1, 6], [3, 19], [6, 29], [8, 15], [10, 12], [11, 1], [11, 11]];
    f = new Set(
      [
        ...[[1, 1], [5, 1], [7, 20], [8, 7], [12, 8], [12, 25]].map(([m, d]) => utc(anio, m, d)),
        ...trasladables.map(([m, d]) => alLunes(utc(anio, m, d))),
        mas(p, -3), mas(p, -2), mas(p, 43), mas(p, 64), mas(p, 71),
      ].map(iso),
    );
    cache.set(anio, f);
  }
  return f;
}

export function esDiaHabil(fecha: string): boolean {
  const d = new Date(`${fecha}T00:00:00Z`);
  const dia = d.getUTCDay();
  return dia !== 0 && dia !== 6 && !festivosColombia(d.getUTCFullYear()).has(fecha);
}

/** `fecha` más `n` días hábiles: el día de partida no cuenta. 'AAAA-MM-DD'. */
export function sumarDiasHabiles(fecha: string, n: number): string {
  let d = new Date(`${fecha}T00:00:00Z`);
  for (let k = 0; k < n; ) {
    d = mas(d, 1);
    if (esDiaHabil(iso(d))) k++;
  }
  return iso(d);
}
