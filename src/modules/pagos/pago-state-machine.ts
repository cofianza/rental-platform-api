/**
 * Pago State Machine (HP-352)
 *
 * Single source of truth for all payment state transitions.
 * ALL estado changes MUST go through transitionPagoState().
 * No other code should modify the estado field directly.
 */

import { supabase } from '@/lib/supabase';
import { AppError, fromSupabaseError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';

// ============================================================
// State machine definition
// ============================================================

export type EstadoPago = 'pendiente' | 'procesando' | 'completado' | 'fallido' | 'reembolsado' | 'cancelado';

/** Map of current state → allowed target states */
const VALID_TRANSITIONS: Record<EstadoPago, EstadoPago[]> = {
  pendiente: ['procesando', 'completado', 'cancelado'],
  procesando: ['completado', 'fallido'],
  completado: ['reembolsado'],
  fallido: ['pendiente'], // retry
  cancelado: [],          // final state
  reembolsado: [],        // final state
};

/** Map target estado → event type for PaymentEvent */
const ESTADO_EVENT_MAP: Record<EstadoPago, string> = {
  pendiente: 'processing_retry',
  procesando: 'processing',
  completado: 'completed',
  fallido: 'failed',
  reembolsado: 'refunded',
  cancelado: 'cancelled',
};

export function isValidTransition(from: EstadoPago, to: EstadoPago): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isFinalState(estado: EstadoPago): boolean {
  return VALID_TRANSITIONS[estado]?.length === 0;
}

// ============================================================
// Centralized transition function
// ============================================================

export interface TransitionParams {
  pagoId: string;
  targetEstado: EstadoPago;
  origen: 'system' | 'webhook' | 'manual';
  /** Extra data to store in PaymentEvent detalles */
  detalles?: Record<string, unknown>;
  /** Extra columns to update on the pagos row (e.g. transaction_ref, gateway_response) */
  extraUpdate?: Record<string, unknown>;
  /** User who triggered the transition (null for webhooks) */
  userId?: string | null;
  ip?: string;
}

const PAGO_SELECT = `
  id, expediente_id, concepto, descripcion, monto, moneda, metodo, estado,
  payment_link_url, external_id, transaction_ref, gateway_response,
  comprobante_url, comprobante_storage_key, comprobante_nombre_original,
  comprobante_tipo_mime, comprobante_tamano_bytes, referencia_bancaria,
  notas, fecha_pago, created_at, updated_at, creado_por,
  email_pagador, nombre_pagador
`;

/**
 * Execute a state transition atomically:
 * 1. Fetch current pago + validate transition
 * 2. Update estado (+ optional extra columns)
 * 3. Insert PaymentEvent
 * 4. Fire side-effects (notifications)
 *
 * Returns the updated pago record.
 */
export async function transitionPagoState(params: TransitionParams) {
  const { pagoId, targetEstado, origen, detalles, extraUpdate, userId, ip } = params;

  // 1. Fetch current pago
  const { data: pago, error: fetchError } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, expediente_id, concepto')
    .eq('id', pagoId)
    .single();

  if (fetchError || !pago) {
    throw AppError.notFound('Pago no encontrado');
  }

  const currentEstado = (pago as { estado: string }).estado as EstadoPago;

  // Idempotency: already in target state → return silently
  if (currentEstado === targetEstado) {
    logger.info({ pagoId, estado: targetEstado }, 'Transition skipped — already in target state');
    const { data: existing } = await (supabase
      .from('pagos' as string) as ReturnType<typeof supabase.from>)
      .select(PAGO_SELECT)
      .eq('id', pagoId)
      .single();
    return existing;
  }

  // 2. Validate transition
  if (!isValidTransition(currentEstado, targetEstado)) {
    throw AppError.badRequest(
      `No se puede cambiar de '${currentEstado}' a '${targetEstado}'`,
      'TRANSICION_INVALIDA',
    );
  }

  // 3. Build update payload
  const updatePayload: Record<string, unknown> = {
    estado: targetEstado,
    ...extraUpdate,
  };

  // Auto-set fecha_pago when completing
  if (targetEstado === 'completado' && !extraUpdate?.fecha_pago) {
    updatePayload.fecha_pago = new Date().toISOString();
  }

  // 4. Update pago
  const { data: updated, error: updateError } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .update(updatePayload as never)
    .eq('id', pagoId)
    .select(PAGO_SELECT)
    .single();

  if (updateError) {
    logger.error({ error: updateError.message, pagoId, targetEstado }, 'Error updating pago state');
    throw fromSupabaseError(updateError);
  }

  // 5. Insert PaymentEvent (atomic with the update via sequential calls)
  const eventType = ESTADO_EVENT_MAP[targetEstado];
  const eventDetalles = {
    estado_anterior: currentEstado,
    estado_nuevo: targetEstado,
    ...(userId && { usuario_id: userId }),
    ...detalles,
  };

  const { error: eventError } = await (supabase
    .from('eventos_pago' as string) as ReturnType<typeof supabase.from>)
    .insert({
      pago_id: pagoId,
      tipo: eventType,
      origen,
      detalles: eventDetalles,
    } as never);

  if (eventError) {
    logger.warn({ error: eventError.message, pagoId, eventType }, 'Error recording transition event');
  }

  // 6. Audit log
  logAudit({
    usuarioId: userId || null,
    accion: AUDIT_ACTIONS.PAGO_STATE_TRANSITIONED,
    entidad: AUDIT_ENTITIES.PAGO,
    entidadId: pagoId,
    detalle: {
      estado_anterior: currentEstado,
      estado_nuevo: targetEstado,
      origen,
    },
    ip,
  });

  // 7. Side effects (fire-and-forget)
  const expedienteId = (pago as { expediente_id: string }).expediente_id;
  const concepto = (pago as { concepto: string }).concepto;

  if (targetEstado === 'completado') {
    notifyPaymentCompleted(pagoId, expedienteId, concepto).catch(() => {});
  }

  if (targetEstado === 'fallido') {
    notifyPaymentFailed(pagoId, expedienteId, concepto).catch(() => {});
  }

  return updated;
}

// ============================================================
// Get current estado with last transition metadata
// ============================================================

export async function getPagoEstado(pagoId: string) {
  const { data: pago, error } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, fecha_pago, updated_at')
    .eq('id', pagoId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') throw AppError.notFound('Pago no encontrado');
    throw fromSupabaseError(error);
  }

  // Get last transition event
  const { data: lastEvent } = await (supabase
    .from('eventos_pago' as string) as ReturnType<typeof supabase.from>)
    .select('id, tipo, detalles, origen, created_at')
    .eq('pago_id', pagoId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  const pagoTyped = pago as { id: string; estado: string; fecha_pago: string | null; updated_at: string };

  return {
    id: pagoTyped.id,
    estado: pagoTyped.estado,
    es_estado_final: isFinalState(pagoTyped.estado as EstadoPago),
    transiciones_permitidas: VALID_TRANSITIONS[pagoTyped.estado as EstadoPago] || [],
    fecha_pago: pagoTyped.fecha_pago,
    updated_at: pagoTyped.updated_at,
    ultima_transicion: lastEvent || null,
  };
}

// ============================================================
// Get full event history
// ============================================================

export async function getPagoEventos(pagoId: string) {
  // Verify pago exists
  const { error: pagoError } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('id', pagoId)
    .single();

  if (pagoError) {
    if (pagoError.code === 'PGRST116') throw AppError.notFound('Pago no encontrado');
    throw fromSupabaseError(pagoError);
  }

  const { data, error } = await (supabase
    .from('eventos_pago' as string) as ReturnType<typeof supabase.from>)
    .select('id, pago_id, tipo, detalles, origen, created_at')
    .eq('pago_id', pagoId)
    .order('created_at', { ascending: true });

  if (error) {
    logger.error({ error: error.message, pagoId }, 'Error fetching pago eventos');
    throw fromSupabaseError(error);
  }

  return data ?? [];
}

// ============================================================
// Side effects: notifications
// ============================================================

const CONCEPTO_LABELS: Record<string, string> = {
  estudio: 'Estudio de riesgo crediticio',
  garantia: 'Garantia de arrendamiento',
  primer_canon: 'Primer canon de arrendamiento',
  deposito: 'Deposito de garantia',
  otro: 'Otro concepto',
};

async function notifyPaymentCompleted(pagoId: string, expedienteId: string, concepto: string) {
  try {
    const conceptLabel = CONCEPTO_LABELS[concepto] || concepto;

    // Add timeline entry to expediente
    await (supabase
      .from('expediente_timeline' as string) as ReturnType<typeof supabase.from>)
      .insert({
        expediente_id: expedienteId,
        tipo: 'pago_confirmado',
        descripcion: `Pago de ${conceptLabel} confirmado`,
        detalle: { pago_id: pagoId, concepto },
        origen: 'system',
      } as never);

    // If estudio payment completed → unlock expediente flow
    if (concepto === 'estudio') {
      await (supabase
        .from('expediente_timeline' as string) as ReturnType<typeof supabase.from>)
        .insert({
          expediente_id: expedienteId,
          tipo: 'estudio_desbloqueado',
          descripcion: 'Pago de estudio confirmado — flujo de estudio desbloqueado',
          detalle: { pago_id: pagoId, trigger: 'pago_estudio_completado' },
          origen: 'system',
        } as never);

      logger.info({ pagoId, expedienteId }, 'Estudio flow unlocked after payment confirmation');
    }

    logger.info({ pagoId, expedienteId, concepto }, 'Payment completed notification sent');
  } catch (error) {
    logger.warn({ error, pagoId, expedienteId }, 'Error in notifyPaymentCompleted');
  }
}

async function notifyPaymentFailed(pagoId: string, expedienteId: string, concepto: string) {
  try {
    const conceptLabel = CONCEPTO_LABELS[concepto] || concepto;

    // Add timeline entry
    await (supabase
      .from('expediente_timeline' as string) as ReturnType<typeof supabase.from>)
      .insert({
        expediente_id: expedienteId,
        tipo: 'pago_fallido',
        descripcion: `Pago de ${conceptLabel} fallido`,
        detalle: { pago_id: pagoId, concepto },
        origen: 'system',
      } as never);

    logger.info({ pagoId, expedienteId, concepto }, 'Payment failed notification sent');
  } catch (error) {
    logger.warn({ error, pagoId, expedienteId }, 'Error in notifyPaymentFailed');
  }
}
