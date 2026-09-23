import type { PostgrestError } from '@supabase/supabase-js';

/** PostgREST devuelve como máximo 1000 filas por respuesta (max-rows). */
const PAGINA = 1000;

/**
 * Trae TODAS las filas de una consulta paginando con `.range()`. Sin esto, los
 * conteos y sumas que se hacen en JS (KPIs, reportes, exportaciones) se cortan
 * en silencio en 1000 filas.
 *
 * `pagina(desde, hasta)` arma la consulta desde cero en cada vuelta y termina en
 * `.order(...).range(desde, hasta)`: el orden tiene que ser estable (por `id`, o
 * con `id` como desempate) para que las páginas no se pisen. `tope` corta antes
 * (la exportación pide una fila de más para saber si truncó).
 */
export async function fetchAll<T>(
  pagina: (desde: number, hasta: number) => PromiseLike<{ data: T[] | null; error: PostgrestError | null }>,
  tope = Number.POSITIVE_INFINITY,
): Promise<{ data: T[]; error: PostgrestError | null }> {
  const filas: T[] = [];
  for (let desde = 0; filas.length < tope; desde += PAGINA) {
    const { data, error } = await pagina(desde, desde + PAGINA - 1);
    if (error) return { data: filas, error };
    const lote = data ?? [];
    filas.push(...lote);
    if (lote.length < PAGINA) break;
  }
  return { data: filas.length > tope ? filas.slice(0, tope) : filas, error: null };
}
