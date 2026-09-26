// ============================================================
// Horario de cobranza — Ley 2300 de 2023, art. 3. Los WhatsApp de cobro solo
// salen de lunes a viernes de 7 a. m. a 7 p. m. y los sábados de 8 a. m. a
// 3 p. m.; nunca domingos ni festivos, y entre dos WhatsApp de cobro a la
// misma persona pasan al menos DIAS_ENTRE_COBROS_WHATSAPP días. Colombia no
// tiene horario de verano: UTC-5 todo el año.
// ============================================================

import { festivosColombia } from '@/lib/diasHabiles';

const BOGOTA_MS = 5 * 60 * 60 * 1000;
const HORA_MS = 60 * 60 * 1000;
const DIA_MS = 24 * HORA_MS;

/**
 * Días mínimos entre dos WhatsApp de cobro a la misma persona (mismo canal).
 * Ley 2300 art. 3, pendiente de confirmar con el abogado (interino estricto,
 * revisiones/respuestas-por-documento-2026-09-25.md, punto 15).
 */
export const DIAS_ENTRE_COBROS_WHATSAPP = 7;
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
 * Cuándo puede salir el próximo WhatsApp de cobro al deudor: dentro de la
 * franja y al menos DIAS_ENTRE_COBROS_WHATSAPP días después del último.
 */
export function momentoDeCobro(ahora: Date, ultimoCobro: Date | null): Date {
  const minimo = ultimoCobro ? ultimoCobro.getTime() + DIAS_ENTRE_COBROS_WHATSAPP * DIA_MS : 0;
  return siguienteMomentoPermitido(new Date(Math.max(ahora.getTime(), minimo)));
}
