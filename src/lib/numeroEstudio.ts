/**
 * Flujo §13 (término único «estudio»): el número guardado es «EXP-2026-0005»
 * (lo pone un trigger y NO cambia); a las personas se les muestra
 * «N.° 2026-0005». Solo presentación: correos, notificaciones, WhatsApp y
 * mensajes. Donde el texto no dice ya «estudio», va «Estudio N.° …».
 */
export function formatNumeroEstudio(numero: string | null | undefined): string {
  // Idempotente: un número ya formateado no queda «N.° N.° …».
  return numero ? `N.° ${numero.replace(/^(?:EXP-|N\.° )/i, '')}` : '';
}

/**
 * La búsqueda sigue con el número guardado («EXP-2026-0005» y «2026-0005» ya
 * casan por ILIKE); esto además acepta el que se muestra («Estudio N.° 2026-0005»).
 * Solo quita el prefijo si le sigue un número: «estudio» a secas no se toca.
 */
export function limpiarBusquedaNumeroEstudio(q: string): string {
  return q.replace(/^\s*(?:estudio\s*)?(?:n\.?\s*[°º]\s*)?(?=\d{4}-\d)/i, '');
}
