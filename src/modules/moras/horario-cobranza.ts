// ============================================================
// Horario de cobranza — Ley 2300 de 2023, art. 3. Los WhatsApp de cobro solo
// salen de lunes a viernes de 7 a. m. a 7 p. m. y los sábados de 8 a. m. a
// 3 p. m.; nunca domingos ni festivos, y una sola gestión por día al mismo
// deudor. Colombia no tiene horario de verano: UTC-5 todo el año.
// ============================================================

import { festivosColombia } from '@/lib/diasHabiles';

const BOGOTA_MS = 5 * 60 * 60 * 1000;
const HORA_MS = 60 * 60 * 1000;
const DIA_MS = 24 * HORA_MS;
// Por día de la semana (0 = domingo): hora en que abre y hora en que cierra.
const FRANJA: Array<[number, number] | null> = [null, [7, 19], [7, 19], [7, 19], [7, 19], [7, 19], [8, 15]];

/** Día civil en Colombia, 'AAAA-MM-DD'. */
export const diaBogota = (d: Date): string => new Date(d.getTime() - BOGOTA_MS).toISOString().slice(0, 10);

/** `desde` si cae dentro de la franja; si no, la siguiente apertura. */
export function siguienteMomentoPermitido(desde: Date): Date {
  let dia = diaBogota(desde);
  for (let i = 0; i < 15; i++) {
    const inicioDia = Date.parse(`${dia}T00:00:00Z`);
    const franja = FRANJA[new Date(inicioDia).getUTCDay()];
    if (franja && !festivosColombia(Number(dia.slice(0, 4))).has(dia)) {
      const abre = inicioDia + BOGOTA_MS + franja[0] * HORA_MS;
      const cierra = inicioDia + BOGOTA_MS + franja[1] * HORA_MS;
      if (desde.getTime() < cierra) return new Date(Math.max(desde.getTime(), abre));
    }
    dia = new Date(inicioDia + DIA_MS).toISOString().slice(0, 10);
  }
  throw new Error('Sin franja de cobranza en 15 días');
}

/**
 * Cuándo puede salir la próxima gestión de cobro al deudor: dentro de la franja
 * y nunca el mismo día (en Colombia) que la anterior.
 */
export function momentoDeCobro(ahora: Date, ultimaGestion: Date | null): Date {
  const hoy = diaBogota(ahora);
  const desde =
    ultimaGestion && diaBogota(ultimaGestion) >= hoy
      ? new Date(Date.parse(`${hoy}T00:00:00Z`) + DIA_MS + BOGOTA_MS) // mañana, 00:00 en Colombia
      : ahora;
  return siguienteMomentoPermitido(desde);
}
