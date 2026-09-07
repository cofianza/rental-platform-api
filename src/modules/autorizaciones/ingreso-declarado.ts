/**
 * Ingreso DECLARADO por el prospecto (Flujo §8.2) — y su contraste con el
 * estimado por la central (Adenda 1 §8).
 *
 * Lo que la Adenda dejo en firme:
 *
 *   "El ingreso que el prospecto declara en la pantalla de autorizacion NO
 *    alimenta el score ni el DTI. Un dato autorreportado no puede entrar a un
 *    modelo de riesgo. Se almacena aparte, como referencia."
 *
 *   "CAMBIO APROBADO — USO ADICIONAL. El ingreso declarado se utiliza como
 *    contraste automatico. Si la diferencia entre el ingreso declarado y el
 *    ingreso estimado por la central supera un porcentaje configurable
 *    [UMBRAL_DIFERENCIA_INGRESO, 50%], el sistema levanta una bandera de
 *    inconsistencia que escala el caso a revision manual. La bandera no
 *    rechaza."
 *
 * Por eso este archivo tiene DOS mitades:
 *   - `senalDiscrepanciaIngreso`: PURA. Es la unica aritmetica, y la cubre
 *     scripts/check-ingreso-declarado.ts.
 *   - `contrasteIngresoProspecto`: lee el declarado de la fila del §8.2 y
 *     devuelve el motivo de revision (o null). La llama reglas-duras.ts
 *     DESDE AQUI y no al reves: src/modules/estudios/ tiene prohibido nombrar
 *     el ingreso declarado (el guard del check), porque el motor no puede
 *     verlo. El motor recibe el ESTIMADO; el declarado nunca entra.
 *
 * El contraste se hace contra el estimado CRUDO de la central, no contra el
 * ajustado por FACTOR_AJUSTE_INGRESO: la Adenda quiere medir cuanto se aleja
 * lo que dice la persona de lo que dice la central, y ese dato es tambien lo
 * que "sirve para calibrar el FACTOR_AJUSTE_INGRESO con datos reales".
 */

import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';

/** Default de la Adenda §8. El vigente lo manda el panel de calibracion. */
export const DISCREPANCIA_INGRESO_PCT = 50;

/**
 * ¿El ingreso declarado se aleja del estimado mas de `umbralPct`?
 *
 * Devuelve null — no "false" — cuando falta cualquiera de los dos. La
 * ausencia del estimado NO se rellena con el declarado: eso taparia la brecha
 * de fuentes en vez de arreglarla.
 */
export function senalDiscrepanciaIngreso(
  declaradoCop: number | null | undefined,
  estimadoCop: number | null | undefined,
  umbralPct: number = DISCREPANCIA_INGRESO_PCT,
): { hay: boolean; desviacion_pct: number; umbral_pct: number } | null {
  if (typeof declaradoCop !== 'number' || !Number.isFinite(declaradoCop) || declaradoCop <= 0) return null;
  if (typeof estimadoCop !== 'number' || !Number.isFinite(estimadoCop) || estimadoCop <= 0) return null;
  const desviacion = (Math.abs(declaradoCop - estimadoCop) / estimadoCop) * 100;
  return {
    hay: desviacion > umbralPct,
    desviacion_pct: Math.round(desviacion * 100) / 100,
    umbral_pct: umbralPct,
  };
}

/** Motivo para el gestor. Pura, para poder probar el texto. */
export function motivoContrasteIngreso(
  declaradoCop: number,
  estimadoCop: number,
  senal: { desviacion_pct: number; umbral_pct: number },
): string {
  const cop = (n: number) => `$${new Intl.NumberFormat('es-CO').format(Math.round(n))}`;
  const direccion = declaradoCop > estimadoCop ? 'por encima' : 'por debajo';
  return (
    `Revision manual (Adenda §8): el ingreso declarado por el prospecto (${cop(declaradoCop)}) esta ${senal.desviacion_pct}% ${direccion} ` +
    `del estimado por la central (${cop(estimadoCop)}); el umbral es ${senal.umbral_pct}%. La bandera no rechaza: un analista contrasta las dos cifras.`
  );
}

/**
 * Adenda §8 en produccion: lee el declarado del expediente y lo contrasta con
 * el estimado CRUDO de la central. Devuelve el motivo de revision manual, o
 * null si no hay declarado, no hay estimado, o estan dentro del umbral.
 *
 * NUNCA lanza: un fallo leyendo la fila deja el contraste en "no se pudo" y
 * el estudio sigue su curso (Politica §2, falla controlada).
 */
export async function contrasteIngresoProspecto(
  expedienteId: string,
  estimadoCrudoCop: number | null | undefined,
  umbralPct: number,
): Promise<string | null> {
  if (typeof estimadoCrudoCop !== 'number' || !Number.isFinite(estimadoCrudoCop) || estimadoCrudoCop <= 0) return null;
  try {
    const { data, error } = await (supabase
      .from('autorizacion_perfil_prospecto' as string) as ReturnType<typeof supabase.from>)
      .select('ingreso_declarado_cop')
      .eq('expediente_id', expedienteId)
      .maybeSingle();
    if (error) {
      logger.warn({ expedienteId, error: error.message }, 'Contraste de ingreso: no se pudo leer el declarado');
      return null;
    }
    const bruto = (data as { ingreso_declarado_cop?: number | string | null } | null)?.ingreso_declarado_cop;
    const declarado = typeof bruto === 'string' ? Number(bruto) : bruto;
    const senal = senalDiscrepanciaIngreso(declarado ?? null, estimadoCrudoCop, umbralPct);
    if (!senal || !senal.hay) return null;
    return motivoContrasteIngreso(declarado as number, estimadoCrudoCop, senal);
  } catch (err) {
    logger.warn({ expedienteId, err: err instanceof Error ? err.message : String(err) }, 'Contraste de ingreso: excepcion');
    return null;
  }
}
