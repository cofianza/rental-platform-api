/**
 * Constancia del cierre sin acta de entrega (Adenda 1 contratos, respuesta 21):
 * quién, cuándo y por qué. Se lee aparte y sin fallar: si el API sale antes que
 * la migración 20260930000002 (columna inexistente), responde null en vez de
 * tumbar el detalle del estudio o la vista del contrato.
 */

import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabase';

const db = (t: string) => supabase.from(t as string) as ReturnType<typeof supabase.from>;

export interface CierreSinActa {
  en: string;
  /** Nombre del administrador que cerró; null si ya no se encuentra su perfil. */
  porNombre: string | null;
  motivo: string;
}

/** Falta la columna (migración sin correr): 42703 al leerla, PGRST204 al escribirla. */
export const faltaColumna = (e: { code?: string } | null | undefined) => e?.code === '42703' || e?.code === 'PGRST204';

/** Nunca lanza: ante cualquier fallo responde null (el estudio se muestra sin la constancia). */
export async function leerCierreSinActa(expedienteId: string): Promise<CierreSinActa | null> {
  try {
    const { data, error } = await db('expedientes')
      .select('cierre_sin_acta_en, cierre_sin_acta_por, cierre_sin_acta_motivo')
      .eq('id', expedienteId)
      .maybeSingle();
    if (error) {
      if (!faltaColumna(error)) logger.warn({ expedienteId, error: error.message }, 'No se pudo leer el cierre sin acta');
      return null;
    }
    const r = data as { cierre_sin_acta_en: string | null; cierre_sin_acta_por: string | null; cierre_sin_acta_motivo: string | null } | null;
    if (!r?.cierre_sin_acta_en) return null;
    const { data: p } = r.cierre_sin_acta_por
      ? await db('perfiles').select('nombre, apellido').eq('id', r.cierre_sin_acta_por).maybeSingle()
      : { data: null };
    const perfil = p as { nombre: string | null; apellido: string | null } | null;
    const nombre = `${perfil?.nombre ?? ''} ${perfil?.apellido ?? ''}`.trim();
    return { en: r.cierre_sin_acta_en, porNombre: nombre || null, motivo: r.cierre_sin_acta_motivo ?? '' };
  } catch (e) {
    logger.warn({ expedienteId, error: e instanceof Error ? e.message : String(e) }, 'No se pudo leer el cierre sin acta');
    return null;
  }
}
