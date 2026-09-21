/**
 * Contratos V3 — borradores aprobados (Entrega 2, diseño §6.c).
 *
 * Todo texto que no está en el Word va en la plantilla como borrador
 * `[[cond: texto Word | #id: borrador]]` y bloquea el modo final hasta que
 * alguien con autoridad (Mario / Gerencia) lo apruebe. Aprobarlo = agregar aquí
 * su entrada, en un commit propio, con el sha256 que imprime borradores.txt
 * (Plantilla.borradores[].sha256):
 *
 *   'c-01': { sha256: '<64 hex>', aprobadoPor: 'Mario …', fecha: '2026-09-30' },
 *
 * La aprobación queda atada al TEXTO: si el borrador se edita, su sha256 cambia
 * y vuelve a quedar pendiente (el motor compara `sha256`, nada más).
 */

export interface Aprobacion {
  /** sha256 del texto del borrador tal como está en la plantilla. */
  sha256: string;
  /** Quién lo aprobó, como consta en el correo o acta. */
  aprobadoPor: string;
  /** AAAA-MM-DD de la aprobación. */
  fecha: string;
}

/** id del borrador → aprobación. Vacío: ningún borrador aprobado todavía. */
export const APROBACIONES: Readonly<Record<string, Aprobacion>> = {};
