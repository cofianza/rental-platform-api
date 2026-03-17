import { supabase } from '@/lib/supabase';
import { AppError, fromSupabaseError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { getPaymentGateway } from './gateway';
import type { CreatePaymentLinkInput, RegisterManualPaymentInput, ListPagosQuery } from './pagos.schema';

// ============================================================
// Helpers
// ============================================================

const PAGO_SELECT = `
  id, expediente_id, concepto, descripcion, monto, moneda, metodo, estado,
  payment_link_url, external_id, transaction_ref, gateway_response,
  comprobante_url, notas, fecha_pago, created_at, updated_at, creado_por
`;

async function recordEvent(
  pagoId: string,
  tipo: string,
  origen: 'system' | 'webhook' | 'manual' = 'system',
  detalles?: Record<string, unknown>,
) {
  const { error } = await (supabase
    .from('eventos_pago' as string) as ReturnType<typeof supabase.from>)
    .insert({ pago_id: pagoId, tipo, origen, detalles: detalles || null } as never);

  if (error) {
    logger.warn({ error: error.message, pagoId, tipo }, 'Error al registrar evento de pago');
  }
}

// ============================================================
// List pagos
// ============================================================

export async function listPagos(query: ListPagosQuery) {
  const { page, limit, expediente_id, concepto, estado, sortBy, sortDir } = query;
  const offset = (page - 1) * limit;

  let builder = (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .select(PAGO_SELECT, { count: 'exact' });

  if (expediente_id) builder = builder.eq('expediente_id', expediente_id);
  if (concepto) builder = builder.eq('concepto', concepto);
  if (estado) {
    const estados = estado.split(',').map((s) => s.trim()).filter(Boolean);
    builder = builder.in('estado', estados);
  }

  builder = builder.order(sortBy, { ascending: sortDir === 'asc' });
  builder = builder.range(offset, offset + limit - 1);

  const { data, count, error } = await builder;

  if (error) {
    logger.error({ error: error.message }, 'Error al listar pagos');
    throw fromSupabaseError(error);
  }

  return {
    pagos: data ?? [],
    pagination: {
      total: count ?? 0,
      page,
      limit,
      totalPages: Math.ceil((count ?? 0) / limit),
    },
  };
}

// ============================================================
// Get pago by ID
// ============================================================

export async function getPagoById(id: string) {
  const { data, error } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .select(PAGO_SELECT)
    .eq('id', id)
    .single();

  if (error) {
    if (error.code === 'PGRST116') throw AppError.notFound('Pago no encontrado');
    throw fromSupabaseError(error);
  }

  return data;
}

// ============================================================
// Get eventos by pago ID
// ============================================================

export async function getEventosByPagoId(pagoId: string) {
  const { data, error } = await (supabase
    .from('eventos_pago' as string) as ReturnType<typeof supabase.from>)
    .select('id, pago_id, tipo, detalles, origen, created_at')
    .eq('pago_id', pagoId)
    .order('created_at', { ascending: true });

  if (error) {
    logger.error({ error: error.message, pagoId }, 'Error al obtener eventos de pago');
    throw fromSupabaseError(error);
  }

  return data ?? [];
}

// ============================================================
// Create payment link (via Stripe)
// ============================================================

export async function createPaymentLink(
  input: CreatePaymentLinkInput,
  userId: string,
  ip?: string,
) {
  // Verify expediente exists
  const { data: expediente, error: expError } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id, numero')
    .eq('id', input.expediente_id)
    .single();

  if (expError || !expediente) {
    throw AppError.notFound('Expediente no encontrado');
  }

  const gateway = getPaymentGateway();
  const conceptLabel = input.concepto.replace(/_/g, ' ');

  // Create checkout session in Stripe
  const linkResult = await gateway.createPaymentLink({
    amount: input.monto,
    concept: `Pago ${conceptLabel} - Exp. ${(expediente as { numero: string }).numero}`,
    description: input.descripcion || `Pago de ${conceptLabel}`,
    metadata: {
      expediente_id: input.expediente_id,
      concepto: input.concepto,
    },
    successUrl: input.success_url,
    cancelUrl: input.cancel_url,
  });

  // Insert pago record
  const { data: pago, error } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: input.expediente_id,
      concepto: input.concepto,
      descripcion: input.descripcion || null,
      monto: input.monto,
      metodo: 'pasarela',
      estado: 'pendiente',
      payment_link_url: linkResult.url,
      external_id: linkResult.externalId,
      creado_por: userId,
    } as never)
    .select(PAGO_SELECT)
    .single();

  if (error) {
    logger.error({ error: error.message }, 'Error al crear registro de pago');
    throw fromSupabaseError(error);
  }

  // Record event
  await recordEvent(pago.id, 'created', 'system', {
    gateway: gateway.provider,
    external_id: linkResult.externalId,
  });

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.PAGO_CREATED,
    entidad: AUDIT_ENTITIES.PAGO,
    entidadId: pago.id,
    detalle: { expediente_id: input.expediente_id, concepto: input.concepto, monto: input.monto },
    ip,
  });

  return pago;
}

// ============================================================
// Register manual payment
// ============================================================

export async function registerManualPayment(
  input: RegisterManualPaymentInput,
  userId: string,
  ip?: string,
) {
  // Verify expediente exists
  const { error: expError } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('id', input.expediente_id)
    .single();

  if (expError) {
    throw AppError.notFound('Expediente no encontrado');
  }

  const { data: pago, error } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: input.expediente_id,
      concepto: input.concepto,
      descripcion: input.descripcion || null,
      monto: input.monto,
      metodo: input.metodo,
      estado: 'completado',
      comprobante_url: input.comprobante_url || null,
      notas: input.notas || null,
      fecha_pago: input.fecha_pago || new Date().toISOString(),
      creado_por: userId,
    } as never)
    .select(PAGO_SELECT)
    .single();

  if (error) {
    logger.error({ error: error.message }, 'Error al registrar pago manual');
    throw fromSupabaseError(error);
  }

  await recordEvent(pago.id, 'completed', 'manual', {
    metodo: input.metodo,
    registrado_por: userId,
  });

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.PAGO_MANUAL_REGISTERED,
    entidad: AUDIT_ENTITIES.PAGO,
    entidadId: pago.id,
    detalle: { expediente_id: input.expediente_id, concepto: input.concepto, monto: input.monto, metodo: input.metodo },
    ip,
  });

  return pago;
}

// ============================================================
// Process webhook event
// ============================================================

export async function processWebhookEvent(payload: Buffer, signature: string) {
  const gateway = getPaymentGateway();
  const { event, type } = gateway.verifyWebhook(payload, signature);

  logger.info({ type }, 'Stripe webhook event received');

  if (type === 'checkout.session.completed' || type === 'checkout.session.expired') {
    const session = (event as { data?: { object?: { id?: string } } }).data?.object;
    const externalId = session?.id;

    if (!externalId) {
      logger.warn({ type }, 'Webhook event missing session ID');
      return { received: true };
    }

    // Find pago by external_id
    const { data: pago, error } = await (supabase
      .from('pagos' as string) as ReturnType<typeof supabase.from>)
      .select('id, estado')
      .eq('external_id', externalId)
      .single();

    if (error || !pago) {
      logger.warn({ externalId, type }, 'Pago not found for webhook event');
      return { received: true };
    }

    if (type === 'checkout.session.completed') {
      // Get payment status from Stripe to get transaction_ref
      const status = await gateway.getPaymentStatus(externalId);

      await (supabase
        .from('pagos' as string) as ReturnType<typeof supabase.from>)
        .update({
          estado: 'completado',
          transaction_ref: status.transactionRef,
          gateway_response: status.rawResponse,
          fecha_pago: new Date().toISOString(),
        } as never)
        .eq('id', pago.id);

      await recordEvent(pago.id, 'completed', 'webhook', {
        stripe_event_type: type,
        transaction_ref: status.transactionRef,
      });

      logger.info({ pagoId: pago.id, externalId }, 'Pago completed via webhook');
    } else if (type === 'checkout.session.expired') {
      await (supabase
        .from('pagos' as string) as ReturnType<typeof supabase.from>)
        .update({ estado: 'cancelado' } as never)
        .eq('id', pago.id);

      await recordEvent(pago.id, 'cancelled', 'webhook', {
        stripe_event_type: type,
      });

      logger.info({ pagoId: pago.id, externalId }, 'Pago cancelled (session expired) via webhook');
    }
  }

  return { received: true };
}

// ============================================================
// Gateway config (public key)
// ============================================================

export function getGatewayConfig() {
  const gateway = getPaymentGateway();
  return {
    provider: gateway.provider,
    publishable_key: gateway.getPublicKey(),
  };
}

// ============================================================
// Gateway health check
// ============================================================

export async function getGatewayStatus() {
  const gateway = getPaymentGateway();
  return gateway.healthCheck();
}
