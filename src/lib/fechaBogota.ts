// Colombia no tiene horario de verano: UTC-5 fijo todo el año.
const BOGOTA_OFFSET_MS = 5 * 60 * 60 * 1000;
const SOLO_FECHA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Límites de un filtro "Desde/Hasta" que llega de un <input type="date">
 * ('YYYY-MM-DD'). Postgres lee esa fecha como las 00:00 UTC, que en Bogotá son
 * las 19:00 del día anterior: "Hasta 23-sep" dejaba fuera el 23 entero. Se
 * anclan al día completo en hora Colombia; un valor con hora pasa tal cual.
 */
export const desdeBogota = (v: string): string => (SOLO_FECHA.test(v) ? `${v}T00:00:00-05:00` : v);
export const hastaBogota = (v: string): string => (SOLO_FECHA.test(v) ? `${v}T23:59:59.999-05:00` : v);

/** 'YYYY-MM' del instante en hora Colombia (el servidor corre en UTC). */
export function mesBogota(instante: string | Date): string {
  return new Date(new Date(instante).getTime() - BOGOTA_OFFSET_MS).toISOString().slice(0, 7);
}
