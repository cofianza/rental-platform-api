import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { finalizarContratoVencido } from './contrato-workflow.service';

// Colombia no tiene DST: offset fijo UTC-5.
const BOGOTA_OFFSET_MS = 5 * 60 * 60 * 1000;

// Tope de contratos por ciclo. Si se alcanza, el resto se procesa en el
// siguiente ciclo (se loguea para no esconder el truncamiento).
const BATCH_LIMIT = 200;

/** Fecha de hoy en hora Colombia como 'yyyy-mm-dd'. */
function hoyBogotaISO(): string {
  return new Date(Date.now() - BOGOTA_OFFSET_MS).toISOString().split('T')[0];
}

/**
 * Job de vencimiento: finaliza automaticamente los contratos 'vigente' cuya
 * fecha_fin (DATE, yyyy-mm-dd) ya paso en hora Colombia, y libera el inmueble
 * (la finalizacion dispara el side-effect ocupado -> disponible).
 *
 * Estrictamente menor que hoy: un contrato que termina HOY sigue vigente hasta
 * fin del dia; se finaliza el dia siguiente. Cada contrato se procesa aislado
 * en try-catch para que un fallo individual no detenga al resto.
 */
export async function finalizarContratosVencidos(): Promise<{ revisados: number; finalizados: number }> {
  const hoy = hoyBogotaISO();

  const { data, error } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select('id, fecha_fin')
    .eq('estado', 'vigente')
    .not('fecha_fin', 'is', null)
    .lt('fecha_fin', hoy)
    .order('fecha_fin', { ascending: true })
    .limit(BATCH_LIMIT);

  if (error) {
    logger.error({ error: error.message }, 'finalizarContratosVencidos: error consultando contratos');
    return { revisados: 0, finalizados: 0 };
  }

  const vencidos = (data ?? []) as Array<{ id: string; fecha_fin: string | null }>;
  if (vencidos.length === 0) return { revisados: 0, finalizados: 0 };

  let finalizados = 0;
  for (const c of vencidos) {
    try {
      if (await finalizarContratoVencido(c.id)) finalizados += 1;
    } catch (err) {
      logger.warn({ err, contratoId: c.id }, 'finalizarContratosVencidos: error finalizando contrato');
    }
  }

  if (vencidos.length === BATCH_LIMIT) {
    logger.warn(
      { batch: BATCH_LIMIT },
      'finalizarContratosVencidos: se alcanzo el limite de lote; el resto se procesara en el proximo ciclo',
    );
  }

  logger.info({ revisados: vencidos.length, finalizados, hoy }, 'finalizarContratosVencidos: ciclo completado');
  return { revisados: vencidos.length, finalizados };
}
