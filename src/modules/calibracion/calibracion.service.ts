// ============================================================
// Tablero de calibracion — Adenda 1 §2.4
//
// "el tablero de calibracion debe mostrar el porcentaje de estudios resueltos
// con una sola central y con dos". La fuente es la traza que decidirConCascada
// (estudios.service.ts) deja en `estudios.cascada` al decidir: ahi queda
// `secundaria_consultada` y, si la segunda central RESPONDIO, tambien la
// columna `estudios.proveedor_secundario`. Sin traza (motor apagado, o estudio
// anterior a la Adenda) no se sabe con cuantas se decidio: se cuenta aparte
// como `sin_dato`, no como "una" — inflar "una central" con estudios que el
// motor nunca vio haria mentir el porcentaje que Gerencia quiere vigilar.
// ============================================================

import { supabase } from '@/lib/supabase';
import { fromSupabaseError } from '@/lib/errors';

export interface ResumenCascada {
  /** Inicio de la ventana (ISO). */
  desde: string;
  total: number;
  una_central: number;
  dos_centrales: number;
  sin_dato: number;
}

export type ClaseCascada = 'una_central' | 'dos_centrales' | 'sin_dato';

export interface FilaCascada {
  cascada?: { secundaria_consultada?: unknown } | null;
  proveedor_secundario?: string | null;
}

/** Pura: clasifica un estudio completado por cuantas centrales lo decidieron. */
export function clasificarCascada(fila: FilaCascada): ClaseCascada {
  // La columna se escribe solo cuando la segunda central respondio, y vale
  // aunque la traza no se haya podido persistir: las dos escrituras son
  // best-effort e independientes en decidirConCascada.
  if (fila.proveedor_secundario || fila.cascada?.secundaria_consultada === true)
    return 'dos_centrales';
  if (fila.cascada && typeof fila.cascada === 'object') return 'una_central';
  return 'sin_dato';
}

/** PostgREST corta en 1000 filas por respuesta; se pagina para no truncar. */
const PAGINA = 1000;

export async function resumenCascada(dias: number): Promise<ResumenCascada> {
  const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
  const resumen: ResumenCascada = {
    desde,
    total: 0,
    una_central: 0,
    dos_centrales: 0,
    sin_dato: 0,
  };

  for (let offset = 0; ; offset += PAGINA) {
    const { data, error } = await (
      supabase.from('estudios' as string) as ReturnType<typeof supabase.from>
    )
      .select('id, cascada, proveedor_secundario')
      .eq('estado', 'completado')
      .gte('fecha_completado', desde)
      .order('id', { ascending: true })
      .range(offset, offset + PAGINA - 1);
    if (error) throw fromSupabaseError(error);

    const filas = (data ?? []) as FilaCascada[];
    for (const fila of filas) {
      resumen.total += 1;
      resumen[clasificarCascada(fila)] += 1;
    }
    if (filas.length < PAGINA) break;
  }

  return resumen;
}
