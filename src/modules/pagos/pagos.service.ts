import crypto from 'node:crypto';
import { supabase } from '@/lib/supabase';
import { AppError, fromSupabaseError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { env } from '@/config';
import { sendPaymentLinkEmail } from '@/lib/email';
import { getPaymentGateway } from './gateway';
import { transitionPagoState } from './pago-state-machine';
import type { EstadoPago } from './pago-state-machine';
import type { CreatePaymentLinkInput, RegisterManualPaymentInput, ComprobantePresignedUrlInput, ListPagosQuery } from './pagos.schema';

// ============================================================
// Helpers
// ============================================================

const PAGO_SELECT = `
  id, expediente_id, concepto, descripcion, monto, moneda, metodo, estado,
  payment_link_url, external_id, transaction_ref, gateway_response,
  comprobante_url, comprobante_storage_key, comprobante_nombre_original,
  comprobante_tipo_mime, comprobante_tamano_bytes, referencia_bancaria,
  notas, fecha_pago, created_at, updated_at, creado_por,
  email_pagador, nombre_pagador
`;

const COMPROBANTE_BUCKET = 'pagos-comprobantes';
const PRESIGNED_URL_EXPIRY = 900; // 15 minutes

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

function formatCOP(amount: number): string {
  return `$${amount.toLocaleString('es-CO')}`;
}

const CONCEPTO_LABELS: Record<string, string> = {
  estudio: 'Estudio de riesgo crediticio',
  garantia: 'Garantia de arrendamiento',
  primer_canon: 'Primer canon de arrendamiento',
  deposito: 'Deposito de garantia',
  otro: 'Otro concepto',
};

// ============================================================
// List pagos by expediente
// ============================================================

export async function listPagosByExpediente(expedienteId: string, query: ListPagosQuery) {
  // Apply defaults defensively in case validation middleware didn't run
  const page = query.page ?? 1;
  const limit = query.limit ?? 10;
  const sortBy = query.sortBy ?? 'created_at';
  const sortDir = query.sortDir ?? 'desc';
  const { concepto, estado } = query;
  const offset = (page - 1) * limit;

  let builder = (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .select(PAGO_SELECT, { count: 'exact' })
    .eq('expediente_id', expedienteId);

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
// Get pago by ID (with events)
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
// Get pago detail with events
// ============================================================

export async function getPagoDetailWithEvents(id: string) {
  const pago = await getPagoById(id);

  const { data: eventos, error } = await (supabase
    .from('eventos_pago' as string) as ReturnType<typeof supabase.from>)
    .select('id, pago_id, tipo, detalles, origen, created_at')
    .eq('pago_id', id)
    .order('created_at', { ascending: true });

  if (error) {
    logger.error({ error: error.message, id }, 'Error al obtener eventos de pago');
  }

  return {
    ...pago,
    eventos: eventos ?? [],
  };
}

// ============================================================
// Create payment link (via Stripe) — POST /expedientes/:expedienteId/pagos
// ============================================================

export async function createPaymentLink(
  expedienteId: string,
  input: CreatePaymentLinkInput,
  userId: string,
  ip?: string,
) {
  // 1. Verify expediente exists
  const { data: expediente, error: expError } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id, numero, estado')
    .eq('id', expedienteId)
    .single();

  if (expError || !expediente) {
    throw AppError.notFound('Expediente no encontrado');
  }

  // 2. Check for duplicate: no pendiente/procesando for same expediente+concepto
  const { data: existing } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado')
    .eq('expediente_id', expedienteId)
    .eq('concepto', input.concepto)
    .in('estado', ['pendiente', 'procesando']);

  if (existing && existing.length > 0) {
    throw AppError.conflict(
      `Ya existe un pago ${input.concepto.replace(/_/g, ' ')} pendiente o en proceso para este expediente`,
      'PAGO_DUPLICADO',
    );
  }

  // 3. Build success/cancel URLs
  const resultUrl = `${env.FRONTEND_URL}/pago/resultado`;
  const successUrl = `${resultUrl}?status=success&expediente=${expedienteId}`;
  const cancelUrl = `${resultUrl}?status=cancelled&expediente=${expedienteId}`;

  // 4. Create checkout session in Stripe
  const gateway = getPaymentGateway();
  const conceptLabel = CONCEPTO_LABELS[input.concepto] || input.concepto;
  const expNumero = (expediente as { numero: string }).numero;

  const linkResult = await gateway.createPaymentLink({
    amount: input.monto,
    concept: `${conceptLabel} - Exp. ${expNumero}`,
    description: input.descripcion,
    metadata: {
      expediente_id: expedienteId,
      concepto: input.concepto,
      email_pagador: input.email_pagador,
    },
    successUrl,
    cancelUrl,
  });

  // 5. Insert pago record
  const { data: pago, error } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: expedienteId,
      concepto: input.concepto,
      descripcion: input.descripcion,
      monto: input.monto,
      metodo: 'pasarela',
      estado: 'pendiente',
      payment_link_url: linkResult.url,
      external_id: linkResult.externalId,
      email_pagador: input.email_pagador,
      nombre_pagador: input.nombre_pagador,
      creado_por: userId,
    } as never)
    .select(PAGO_SELECT)
    .single();

  if (error) {
    logger.error({ error: error.message }, 'Error al crear registro de pago');
    throw fromSupabaseError(error);
  }

  // 6. Record event
  await recordEvent(pago.id, 'created', 'system', {
    gateway: gateway.provider,
    external_id: linkResult.externalId,
    email_pagador: input.email_pagador,
  });

  // 7. Send email if requested
  if (input.enviar_email) {
    try {
      await sendPaymentLinkEmail(
        input.email_pagador,
        input.nombre_pagador,
        linkResult.url,
        {
          concepto: conceptLabel,
          monto: formatCOP(input.monto),
          expediente_numero: expNumero,
        },
      );

      await recordEvent(pago.id, 'link_sent', 'system', {
        email: input.email_pagador,
      });
    } catch (emailError) {
      logger.error({ emailError, pagoId: pago.id }, 'Error al enviar email de pago (pago creado correctamente)');
    }
  }

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.PAGO_CREATED,
    entidad: AUDIT_ENTITIES.PAGO,
    entidadId: pago.id,
    detalle: {
      expediente_id: expedienteId,
      concepto: input.concepto,
      monto: input.monto,
      email_pagador: input.email_pagador,
    },
    ip,
  });

  return pago;
}

// ============================================================
// Cancel pago — PATCH /pagos/:pagoId/cancelar
// Uses centralized state machine (HP-352)
// ============================================================

export async function cancelPago(pagoId: string, userId: string, ip?: string) {
  return transitionPagoState({
    pagoId,
    targetEstado: 'cancelado',
    origen: 'manual',
    detalles: { cancelado_por: userId },
    userId,
    ip,
  });
}

// ============================================================
// Resend payment link email — POST /pagos/:pagoId/reenviar-link
// ============================================================

export async function resendPaymentLink(pagoId: string, userId: string, ip?: string) {
  const pago = await getPagoById(pagoId) as {
    id: string;
    estado: string;
    payment_link_url: string | null;
    email_pagador: string | null;
    nombre_pagador: string | null;
    concepto: string;
    monto: number;
    expediente_id: string;
  };

  if (pago.estado !== 'pendiente') {
    throw AppError.badRequest(
      'Solo se puede reenviar el link de pagos en estado pendiente',
      'PAGO_NO_REENVIABLE',
    );
  }

  if (!pago.payment_link_url) {
    throw AppError.badRequest('Este pago no tiene un link de pago asociado', 'NO_PAYMENT_LINK');
  }

  if (!pago.email_pagador) {
    throw AppError.badRequest('Este pago no tiene email del pagador', 'NO_EMAIL_PAGADOR');
  }

  // Get expediente numero for email context
  const { data: expediente } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('numero')
    .eq('id', pago.expediente_id)
    .single();

  const conceptLabel = CONCEPTO_LABELS[pago.concepto] || pago.concepto;
  const expNumero = (expediente as { numero: string } | null)?.numero || '';

  await sendPaymentLinkEmail(
    pago.email_pagador,
    pago.nombre_pagador || '',
    pago.payment_link_url,
    {
      concepto: conceptLabel,
      monto: formatCOP(pago.monto),
      expediente_numero: expNumero,
    },
  );

  await recordEvent(pagoId, 'link_sent', 'system', {
    email: pago.email_pagador,
    reenviado_por: userId,
  });

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.PAGO_LINK_RESENT,
    entidad: AUDIT_ENTITIES.PAGO,
    entidadId: pagoId,
    detalle: { email: pago.email_pagador },
    ip,
  });

  return { message: `Link de pago reenviado a ${pago.email_pagador}` };
}

// ============================================================
// Presigned URL for comprobante upload (HP-350)
// ============================================================

export async function generateComprobantePresignedUrl(
  input: ComprobantePresignedUrlInput,
  userId: string,
) {
  const ext = input.nombre_original.split('.').pop()?.toLowerCase() || 'bin';
  const storageKey = `comprobantes/${userId}/${crypto.randomUUID()}.${ext}`;

  const { data, error } = await supabase.storage
    .from(COMPROBANTE_BUCKET)
    .createSignedUploadUrl(storageKey);

  if (error) {
    logger.error({ error: error.message }, 'Error generating comprobante presigned URL');
    throw AppError.badRequest('Error al generar URL de carga', 'STORAGE_ERROR');
  }

  return {
    signedUrl: data.signedUrl,
    storage_key: storageKey,
    token: data.token,
    expires_in: PRESIGNED_URL_EXPIRY,
  };
}

// ============================================================
// Get comprobante download URL (HP-350)
// ============================================================

export async function getComprobanteUrl(pagoId: string) {
  const pago = await getPagoById(pagoId) as {
    comprobante_storage_key: string | null;
    comprobante_nombre_original: string | null;
  };

  if (!pago.comprobante_storage_key) {
    throw AppError.notFound('Este pago no tiene comprobante adjunto');
  }

  const { data, error } = await supabase.storage
    .from(COMPROBANTE_BUCKET)
    .createSignedUrl(pago.comprobante_storage_key, PRESIGNED_URL_EXPIRY, {
      download: pago.comprobante_nombre_original || 'comprobante',
    });

  if (error) {
    logger.error({ error: error.message, pagoId }, 'Error generating comprobante download URL');
    throw AppError.badRequest('Error al generar URL de descarga', 'STORAGE_ERROR');
  }

  return {
    url: data.signedUrl,
    nombre_original: pago.comprobante_nombre_original,
    expires_in: PRESIGNED_URL_EXPIRY,
  };
}

// ============================================================
// Register manual payment — POST /expedientes/:expedienteId/pagos/manual (HP-350)
// ============================================================

export async function registerManualPayment(
  expedienteId: string,
  input: RegisterManualPaymentInput,
  userId: string,
  ip?: string,
) {
  // Verify expediente exists
  const { error: expError } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('id', expedienteId)
    .single();

  if (expError) {
    throw AppError.notFound('Expediente no encontrado');
  }

  // Validate fecha_pago is not in the future
  const fechaPago = new Date(input.fecha_pago);
  if (fechaPago > new Date()) {
    throw AppError.badRequest('La fecha de pago no puede ser una fecha futura', 'FECHA_FUTURA');
  }

  // If comprobante was provided, verify file exists in storage
  if (input.comprobante_storage_key) {
    const { data: fileCheck } = await supabase.storage
      .from(COMPROBANTE_BUCKET)
      .createSignedUrl(input.comprobante_storage_key, 60);

    if (!fileCheck) {
      throw AppError.badRequest('El comprobante no se encontro en el almacenamiento', 'COMPROBANTE_NOT_FOUND');
    }
  }

  const { data: pago, error } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: expedienteId,
      concepto: input.concepto,
      descripcion: input.descripcion || null,
      monto: input.monto,
      metodo: input.metodo,
      estado: 'completado',
      referencia_bancaria: input.referencia_bancaria || null,
      comprobante_storage_key: input.comprobante_storage_key || null,
      comprobante_nombre_original: input.comprobante_nombre_original || null,
      comprobante_tipo_mime: input.comprobante_tipo_mime || null,
      comprobante_tamano_bytes: input.comprobante_tamano_bytes || null,
      notas: input.notas || null,
      fecha_pago: fechaPago.toISOString(),
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
    tiene_comprobante: !!input.comprobante_storage_key,
  });

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.PAGO_MANUAL_REGISTERED,
    entidad: AUDIT_ENTITIES.PAGO,
    entidadId: pago.id,
    detalle: {
      expediente_id: expedienteId,
      concepto: input.concepto,
      monto: input.monto,
      metodo: input.metodo,
    },
    ip,
  });

  return pago;
}

// ============================================================
// Process webhook event (HP-349 + HP-352)
// Always returns { received: true } — never throws to the gateway.
// Idempotent: duplicate events are silently ignored.
// All state changes go through the centralized state machine.
// ============================================================

/** Map of Stripe event types we handle → target pago estado */
const WEBHOOK_EVENT_MAP: Record<string, EstadoPago> = {
  'checkout.session.completed': 'completado',
  'checkout.session.expired': 'cancelado',
  'checkout.session.async_payment_succeeded': 'completado',
  'checkout.session.async_payment_failed': 'fallido',
  'payment_intent.succeeded': 'completado',
  'payment_intent.payment_failed': 'fallido',
  'charge.refunded': 'reembolsado',
};

export async function processWebhookEvent(payload: Buffer, signature: string) {
  // 1. Verify signature (throws 400 on invalid — this is the ONLY case we reject)
  const gateway = getPaymentGateway();
  const { event, type, eventId } = gateway.verifyWebhook(payload, signature);

  logger.info({ type, eventId }, 'Webhook event received');

  // 2. Check if this is an event type we handle
  const targetEstado = WEBHOOK_EVENT_MAP[type];
  if (!targetEstado) {
    logger.info({ type, eventId }, 'Webhook event type not handled — ignoring');
    return { received: true };
  }

  // 3. Extract external ID from the event
  const eventObj = (event as { data?: { object?: Record<string, unknown> } }).data?.object;
  const externalId = eventObj?.id as string | undefined;

  if (!externalId) {
    logger.warn({ type, eventId }, 'Webhook event missing object ID');
    return { received: true };
  }

  // 4. Find pago — try external_id first, then transaction_ref as fallback.
  //    For checkout.session.* events: external_id = session ID
  //    For payment_intent.* events: try transaction_ref first, then check
  //    if a checkout session stored this payment_intent via metadata.
  let pago: Record<string, unknown> | null = null;

  if (type.startsWith('checkout.session.')) {
    // Checkout events — session ID is our external_id
    const { data } = await (supabase
      .from('pagos' as string) as ReturnType<typeof supabase.from>)
      .select('id, estado')
      .eq('external_id', externalId)
      .single();
    pago = data as Record<string, unknown> | null;
  } else {
    // payment_intent.* or charge.* — try transaction_ref first
    const { data: byRef } = await (supabase
      .from('pagos' as string) as ReturnType<typeof supabase.from>)
      .select('id, estado')
      .eq('transaction_ref', externalId)
      .single();

    if (byRef) {
      pago = byRef as Record<string, unknown>;
    } else {
      // Fallback: for payment_intent events, Stripe includes the checkout session
      // metadata. Try to find pago by matching the payment_intent's metadata.expediente_id
      // or by fetching the checkout session that created this intent.
      const metadata = eventObj?.metadata as Record<string, string> | undefined;
      const expId = metadata?.expediente_id;
      if (expId) {
        const { data: byMeta } = await (supabase
          .from('pagos' as string) as ReturnType<typeof supabase.from>)
          .select('id, estado')
          .eq('expediente_id', expId)
          .eq('metodo', 'pasarela')
          .in('estado', ['pendiente', 'procesando'])
          .order('created_at', { ascending: false })
          .limit(1);
        if (byMeta && byMeta.length > 0) {
          pago = byMeta[0] as Record<string, unknown>;
        }
      }
    }
  }

  if (!pago) {
    logger.warn({ externalId, type, eventId }, 'Pago not found for webhook event');
    return { received: true };
  }

  const pagoId = (pago as { id: string }).id;

  // 5. Idempotency: check if this eventId was already recorded
  const { data: existingEvent } = await (supabase
    .from('eventos_pago' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('pago_id', pagoId)
    .eq('detalles->>stripe_event_id', eventId)
    .limit(1);

  if (existingEvent && existingEvent.length > 0) {
    logger.info({ pagoId, eventId }, 'Duplicate webhook eventId — idempotent skip');
    return { received: true };
  }

  // 6. Build extra update data for completado (fetch Stripe details)
  let extraUpdate: Record<string, unknown> | undefined;
  if (targetEstado === 'completado') {
    try {
      // For checkout.session.* events, externalId is the session ID → use directly.
      // For payment_intent.* events, externalId is the PI ID → use pago's external_id
      // (which is the checkout session ID) to fetch full status.
      let lookupId = externalId;
      if (type.startsWith('payment_intent.')) {
        // Fetch the pago's stored external_id (checkout session ID) for status lookup
        const { data: fullPago } = await (supabase
          .from('pagos' as string) as ReturnType<typeof supabase.from>)
          .select('external_id')
          .eq('id', pagoId)
          .single();
        const storedExternalId = (fullPago as { external_id: string } | null)?.external_id;
        if (storedExternalId) {
          lookupId = storedExternalId;
        } else {
          // No session ID available — store the PI ID as transaction_ref directly
          extraUpdate = { transaction_ref: externalId };
        }
      }

      if (!extraUpdate) {
        const status = await gateway.getPaymentStatus(lookupId);
        extraUpdate = {
          transaction_ref: status.transactionRef,
          gateway_response: status.rawResponse,
        };
      }
    } catch (err) {
      logger.warn({ err, pagoId }, 'Failed to fetch Stripe payment status — proceeding without');
    }
  }

  // 7. Capturar estado previo para guard de idempotencia del orchestrator.
  //    Si el pago ya estaba 'completado' por un evento anterior (posible con
  //    Stripe enviando checkout.session.completed + payment_intent.succeeded
  //    para el mismo pago con eventIds distintos), transitionPagoState hace
  //    idempotent-skip internamente pero NO podemos disparar onPagoConfirmado
  //    de nuevo — ejecutarEstudio cuesta dinero real en TransUnion.
  const estadoAntes = (pago as { estado: string }).estado;

  // 8. Execute transition via state machine
  try {
    await transitionPagoState({
      pagoId,
      targetEstado,
      origen: 'webhook',
      detalles: {
        stripe_event_id: eventId,
        stripe_event_type: type,
        transaction_ref: extraUpdate?.transaction_ref ?? null,
      },
      extraUpdate,
    });

    logger.info({ pagoId, targetEstado, eventId }, 'Webhook state transition completed');
  } catch (processingError) {
    // Log but never throw — always return 200 to the gateway
    logger.error({ processingError, pagoId, eventId, type }, 'Error processing webhook event internally');
    return { received: true };
  }

  // 9. Dispatch al orchestrator solo si la transición fue efectiva.
  //    Guard: targetEstado='completado' + el pago NO estaba ya en 'completado'.
  //    Mantiene 1 única ejecución de TransUnion por pago exitoso.
  if (targetEstado === 'completado' && estadoAntes !== 'completado') {
    try {
      const { data: pagoFull } = await (supabase
        .from('pagos' as string) as ReturnType<typeof supabase.from>)
        .select('id, expediente_id, concepto')
        .eq('id', pagoId)
        .single();

      if (!pagoFull) {
        logger.error({ pagoId }, 'Webhook: pago no encontrado tras transición — no se puede dispatch orchestrator');
        return { received: true };
      }

      const pagoFullTyped = pagoFull as unknown as {
        id: string;
        expediente_id: string;
        concepto: string;
      };

      // Import dinámico: evita el ciclo pagos ↔ orchestrator (el orchestrator
      // ya importa estudios via dynamic, mantiene la asimetría).
      const { onPagoConfirmado } = await import('@/modules/orchestrator/orchestrator.service');
      await onPagoConfirmado({
        pagoId: pagoFullTyped.id,
        expedienteId: pagoFullTyped.expediente_id,
        concepto: pagoFullTyped.concepto,
      });
    } catch (err) {
      // NO re-throw: ya procesamos la transición exitosa. Un 500 al webhook
      // dispararía retry de Stripe y duplicaría el pago.
      logger.error({ pagoId, eventId, err }, 'Webhook: onPagoConfirmado falló — requiere intervención manual');
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
