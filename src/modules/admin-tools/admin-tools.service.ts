// ============================================================
// Admin Tools — TEMPORAL (Mario, 7-may-2026)
//
// Herramientas operativas para QA: el dashboard del administrador expone
// un boton "Borrar datos de prueba" que limpia el ambiente entre rondas.
// El servicio invoca el RPC `fn_wipe_test_data` que es donde vive la
// logica destructiva (transaccional, FK-safe via DEFERRED).
//
// IMPORTANTE: borrar este modulo (route + controller + service) y la
// migracion 20260507000005 antes de pasar a produccion.
// ============================================================

import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';

const CONFIRM_PHRASE = 'BORRAR-TODO';

export interface WipeTestDataResult {
  ok: true;
  deleted: Record<string, number>;
}

/**
 * Limpia los datos transaccionales y las cuentas no-administrador.
 * Solo callable por administradores (gateado en la ruta) y exige una
 * frase de confirmacion en el body para evitar disparos accidentales.
 */
export async function wipeTestData(
  confirm: string,
  invocadoPor: { id: string; email: string },
): Promise<WipeTestDataResult> {
  if (confirm !== CONFIRM_PHRASE) {
    throw AppError.badRequest(
      `Para confirmar la operacion, envia el campo "confirm" con el valor exacto "${CONFIRM_PHRASE}".`,
      'CONFIRMACION_REQUERIDA',
    );
  }

  logger.warn(
    { invocadoPor: invocadoPor.email, userId: invocadoPor.id },
    'WIPE TEST DATA: invocacion recibida — limpiando base de datos',
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc('fn_wipe_test_data');

  if (error) {
    logger.error({ error: error.message }, 'WIPE TEST DATA: RPC fallo');
    throw new AppError(500, 'WIPE_FAILED', `Error al ejecutar el wipe: ${error.message}`);
  }

  const deleted = (data as Record<string, number>) || {};
  logger.warn({ deleted, invocadoPor: invocadoPor.email }, 'WIPE TEST DATA: completado');

  return { ok: true, deleted };
}

export const WIPE_CONFIRM_PHRASE = CONFIRM_PHRASE;
