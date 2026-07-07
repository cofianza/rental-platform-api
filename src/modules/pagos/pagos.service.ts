import crypto from 'node:crypto';
import { supabase } from '@/lib/supabase';
import { AppError, fromSupabaseError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { env } from '@/config';
import { sendPaymentLinkEmail } from '@/lib/email';
import { getPaymentGateway } from './gateway';
import { transitionPagoState, transitionPagoStateChecked, isValidTransition } from './pago-state-machine';
import type { EstadoPago } from './pago-state-machine';
import type { CreatePaymentLinkInput, RegisterManualPaymentInput, ComprobantePresignedUrlInput, ListPagosQuery } from './pagos.schema';
import { notificarUsuario, findPerfilIdByEmail } from '../notificaciones/notificaciones.service';

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

/**
 * Anexa a cada pago la última factura emitida (si existe). Usamos un
 * segundo query en lugar de embed PostgREST porque el schema cache de
 * Supabase a veces no detecta la FK pago_id→pagos y rompe el endpoint.
 *
 * Exportado para que otros modulos (pago-estudio, etc.) puedan reutilizar
 * la misma logica al devolver pagos al frontend — asi el flag
 * facturaExistente en la UI sigue siendo confiable tras refresh.
 */
export async function attachFacturas<T extends Record<string, unknown> & { id: string }>(
  pagos: T[],
): Promise<(T & { factura: { id: string; numero: string | null; estado: string } | null })[]> {
  if (pagos.length === 0) return [];
  const ids = pagos.map((p) => p.id);
  const { data: facturas } = await (supabase
    .from('facturas' as string) as ReturnType<typeof supabase.from>)
    .select('id, pago_id, factus_number, estado, created_at')
    .in('pago_id', ids)
    .eq('estado', 'emitida')
    .order('created_at', { ascending: false });

  const byPago = new Map<string, { id: string; factus_number: string | null; estado: string }>();
  for (const f of (facturas || []) as {
    id: string;
    pago_id: string;
    factus_number: string | null;
    estado: string;
  }[]) {
    if (!byPago.has(f.pago_id)) {
      byPago.set(f.pago_id, { id: f.id, factus_number: f.factus_number, estado: f.estado });
    }
  }

  return pagos.map((p) => {
    const f = byPago.get(p.id);
    return {
      ...p,
      factura: f ? { id: f.id, numero: f.factus_number, estado: f.estado } : null,
    };
  });
}

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
    pagos: await attachFacturas(
      (data ?? []) as unknown as (Record<string, unknown> & { id: string })[],
    ),
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

  const [withFactura] = await attachFacturas([
    data as unknown as Record<string, unknown> & { id: string },
  ]);
  return withFactura;
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

  // 3. Build success/cancel/pending URLs (pending: PSE/efectivo no debe verse como éxito)
  const resultUrl = `${env.FRONTEND_URL}/pago/resultado`;
  const successUrl = `${resultUrl}?status=success&expediente=${expedienteId}`;
  const cancelUrl = `${resultUrl}?status=cancelled&expediente=${expedienteId}`;
  const pendingUrl = `${resultUrl}?status=pending&expediente=${expedienteId}`;

  const gateway = getPaymentGateway();
  const conceptLabel = CONCEPTO_LABELS[input.concepto] || input.concepto;
  const expNumero = (expediente as { numero: string }).numero;

  // 4. Insert pago record ANTES de crear el checkout, con id pre-generado: así
  // la preference lleva el pago_id en external_reference/metadata y el webhook
  // puede casar el pago EXACTO (no "el más reciente del expediente").
  const pagoId = crypto.randomUUID();
  const { error: insertError } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .insert({
      id: pagoId,
      expediente_id: expedienteId,
      concepto: input.concepto,
      descripcion: input.descripcion,
      monto: input.monto,
      metodo: 'pasarela',
      estado: 'pendiente',
      email_pagador: input.email_pagador,
      nombre_pagador: input.nombre_pagador,
      creado_por: userId,
    } as never);

  if (insertError) {
    // 23505 = índice único uq_pagos_estudio_activo (carrera de doble click).
    if (insertError.code === '23505') {
      throw AppError.conflict(
        `Ya existe un pago ${input.concepto.replace(/_/g, ' ')} activo para este expediente`,
        'PAGO_DUPLICADO',
      );
    }
    logger.error({ error: insertError.message }, 'Error al crear registro de pago');
    throw fromSupabaseError(insertError);
  }

  // 5. Create checkout session in the gateway; si falla, no dejamos fila huérfana.
  let linkResult: { url: string; externalId: string };
  try {
    linkResult = await gateway.createPaymentLink({
      amount: input.monto,
      concept: `${conceptLabel} - Exp. ${expNumero}`,
      description: input.descripcion,
      metadata: {
        expediente_id: expedienteId,
        concepto: input.concepto,
        email_pagador: input.email_pagador,
        pago_id: pagoId,
      },
      successUrl,
      cancelUrl,
      pendingUrl,
    });
  } catch (gatewayError) {
    await (supabase
      .from('pagos' as string) as ReturnType<typeof supabase.from>)
      .delete()
      .eq('id', pagoId);
    throw gatewayError;
  }

  // 5b. Persistir el link en la fila — CAS sobre 'pendiente': si el pago fue
  // cancelado concurrentemente mientras creábamos el checkout, NO adjuntamos un
  // link pagable a un pago cancelado (expiramos la preference y abortamos).
  const { data: pago, error } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .update({
      payment_link_url: linkResult.url,
      external_id: linkResult.externalId,
    } as never)
    .eq('id', pagoId)
    .eq('estado', 'pendiente')
    .select(PAGO_SELECT)
    .maybeSingle();

  if (error) {
    logger.error({ error: error.message, pagoId }, 'Error al guardar el link en el pago — se revierte');
    await (supabase
      .from('pagos' as string) as ReturnType<typeof supabase.from>)
      .delete()
      .eq('id', pagoId);
    if (gateway.cancelPaymentLink) {
      gateway.cancelPaymentLink(linkResult.externalId).catch((err) =>
        logger.warn({ err, externalId: linkResult.externalId }, 'No se pudo expirar la preference tras revertir'),
      );
    }
    throw fromSupabaseError(error);
  }

  if (!pago) {
    // 0 filas: cancelación concurrente. La fila es historial (ya 'cancelado') —
    // no se borra; el link recién creado se invalida para que no sea pagable.
    if (gateway.cancelPaymentLink) {
      gateway.cancelPaymentLink(linkResult.externalId).catch((err) =>
        logger.warn({ err, externalId: linkResult.externalId }, 'No se pudo expirar la preference tras cancelación concurrente'),
      );
    }
    throw AppError.conflict('El pago fue cancelado mientras se creaba el link', 'PAGO_CANCELADO_CONCURRENTE');
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
  const pago = await transitionPagoState({
    pagoId,
    targetEstado: 'cancelado',
    origen: 'manual',
    detalles: { cancelado_por: userId },
    userId,
    ip,
  });

  // Expirar el link en la pasarela (best-effort): un pago cancelado no debe
  // seguir siendo pagable desde el email del arrendatario.
  const p = pago as { external_id?: string | null; metodo?: string | null } | null;
  if (p?.metodo === 'pasarela' && p.external_id) {
    const gateway = getPaymentGateway();
    if (gateway.cancelPaymentLink) {
      gateway.cancelPaymentLink(p.external_id).catch((err) =>
        logger.warn({ err, pagoId }, 'No se pudo expirar el link en la pasarela (pago ya cancelado en BD)'),
      );
    }
  }

  return pago;
}

/**
 * Cancela TODOS los pagos pendientes/en proceso de un expediente. Variante de
 * SISTEMA (userId null) para los side-effects de "Terminar/Cancelar contrato".
 * ALCANCE: `pagos` NO tiene `contrato_id` (solo `expediente_id`), así que esto
 * cancela CUALQUIER pago pendiente del expediente sin importar concepto/contrato.
 * En el modelo normal (1 expediente ≈ 1 relación de arriendo) es correcto; el
 * caller ya gatea con `inmuebleLiberado` (no se llama si hay renovación en curso
 * que podría financiarse con esos links).
 * sin esto, un link de pago pendiente seguía siendo pagable y un webhook tardío
 * lo completaba, mandaba "¡recibimos tu pago!" y facturaba en Factus sobre un
 * contrato ya terminado. LOG-ONLY: nunca lanza — la transición del contrato ya
 * quedó confirmada. Un pago 'procesando' (PSE) que luego aprueba cae a
 * pagos_no_conciliados (fail-safe existente) para conciliación/reembolso manual.
 * Expira además el link en la pasarela (best-effort).
 */
export async function cancelarPagosPendientesDeExpediente(
  expedienteId: string,
  motivo: string,
): Promise<void> {
  try {
    const { data } = await (supabase
      .from('pagos' as string) as ReturnType<typeof supabase.from>)
      .select('id, estado, metodo, external_id')
      .eq('expediente_id', expedienteId)
      .in('estado', ['pendiente', 'procesando']);
    const pagos = (data as Array<{ id: string; estado: string; metodo: string | null; external_id: string | null }> | null) ?? [];

    for (const pago of pagos) {
      try {
        await transitionPagoState({
          pagoId: pago.id,
          targetEstado: 'cancelado',
          origen: 'system',
          detalles: { motivo, cancelado_por: 'sistema' },
          userId: null,
        });
        // Expirar el link en la pasarela (best-effort): un pago cancelado no
        // debe seguir siendo pagable desde el email del arrendatario.
        if (pago.metodo === 'pasarela' && pago.external_id) {
          const gateway = getPaymentGateway();
          if (gateway.cancelPaymentLink) {
            gateway.cancelPaymentLink(pago.external_id).catch((err) =>
              logger.warn({ err, pagoId: pago.id }, 'No se pudo expirar el link en la pasarela'),
            );
          }
        }
      } catch (err) {
        logger.warn(
          { err, pagoId: pago.id, expedienteId },
          'No se pudo cancelar un pago pendiente al terminar el contrato',
        );
      }
    }
    if (pagos.length > 0) {
      logger.info({ expedienteId, cancelados: pagos.length }, 'Pagos pendientes cancelados al terminar el contrato');
    }
  } catch (err) {
    logger.error({ err, expedienteId }, 'Error cancelando pagos pendientes del expediente');
  }
}

// ============================================================
// Resend payment link email — POST /pagos/:pagoId/reenviar-link
// ============================================================

export async function resendPaymentLink(pagoId: string, userId: string, ip?: string) {
  const pago = await getPagoById(pagoId) as unknown as {
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
  const pago = await getPagoById(pagoId) as unknown as {
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

export async function processWebhookEvent(
  payload: Buffer,
  headers: Record<string, string | string[] | undefined>,
  query?: Record<string, unknown>,
) {
  // 1. Verify signature (throws 400 on invalid — this is the ONLY case we reject)
  const gateway = getPaymentGateway();
  const { event, type, eventId } = gateway.verifyWebhook(payload, headers, query);

  logger.info({ provider: gateway.provider, type, eventId }, 'Webhook event received');

  // Mercado Pago usa un modelo de webhook distinto a Stripe (el evento es solo un
  // aviso con un payment id; el estado real se consulta y el cruce va por
  // external_reference). Se maneja en su propia ruta.
  if (gateway.provider === 'mercadopago') {
    return processMercadoPagoWebhook(eventId, type, gateway);
  }

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

  // 3.5. Dispatch alterno: compras de creditos de estudios (no usan tabla pagos).
  //      La compra se identifica por metadata.concepto = 'creditos_estudios' y
  //      se despacha a creditos-estudios.service para crear el lote.
  const metadata = eventObj?.metadata as Record<string, string> | undefined;
  if (metadata?.concepto === 'creditos_estudios' && type === 'checkout.session.completed') {
    try {
      const { acreditarCompraDesdeWebhook } = await import('@/modules/creditos-estudios/creditos-estudios.service');
      const paymentIntentId = (eventObj?.payment_intent as string | null) ?? null;
      const result = await acreditarCompraDesdeWebhook(externalId, paymentIntentId, eventObj || {});
      logger.info({ externalId, eventId, result }, 'Creditos estudios: compra acreditada via webhook');
    } catch (err) {
      logger.error({ err, externalId, eventId }, 'Error acreditando compra de creditos via webhook');
    }
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
    // Dispatch reutilizable (mismo camino que el endpoint dev de simulación),
    // para que webhook real y simulación no se desincronicen.
    await dispatchPagoCompletado(pagoId);
  }

  return { received: true };
}

/**
 * Despacha el orquestador tras un pago que ACABA de transicionar a 'completado'
 * (estudio automático + auto-envío del link de autorización + facturación) y
 * notifica al solicitante. Best-effort: registra el error pero nunca relanza
 * (un 500 al webhook dispararía retry de Stripe). Llamar SOLO en la primera
 * transición a 'completado' para no duplicar el dispatch.
 */
export async function dispatchPagoCompletado(pagoId: string): Promise<void> {
  try {
    const { data: pagoFull } = await (supabase
      .from('pagos' as string) as ReturnType<typeof supabase.from>)
      .select('id, expediente_id, concepto')
      .eq('id', pagoId)
      .single();

    if (!pagoFull) {
      logger.error({ pagoId }, 'dispatchPagoCompletado: pago no encontrado tras transición');
      return;
    }

    const p = pagoFull as unknown as { id: string; expediente_id: string; concepto: string };

    // Import dinámico: evita el ciclo pagos ↔ orchestrator.
    const { onPagoConfirmado } = await import('@/modules/orchestrator/orchestrator.service');
    await onPagoConfirmado({ pagoId: p.id, expedienteId: p.expediente_id, concepto: p.concepto });

    // Notificación in-app al solicitante. Fire-and-forget.
    notificarSolicitantePagoCompletado(p.id, p.expediente_id, p.concepto).catch((e) =>
      logger.warn({ error: e, pagoId: p.id }, 'Error notificando pago completado'),
    );
  } catch (err) {
    logger.error({ pagoId, err }, 'dispatchPagoCompletado: onPagoConfirmado falló — requiere intervención manual');
  }
}

// ============================================================
// Mercado Pago webhook handler
// El webhook de MP es solo un aviso (type=payment + data.id). Consultamos el
// pago real, mapeamos su estado y cruzamos con NUESTRO registro vía
// external_reference = "<concepto>:<expediente_id|compra_id>".
// Siempre responde 200 (salvo firma inválida, que se rechaza antes en verifyWebhook).
// ============================================================

async function processMercadoPagoWebhook(
  paymentId: string,
  type: string,
  gateway: ReturnType<typeof getPaymentGateway>,
): Promise<{ received: true }> {
  // Solo nos interesan notificaciones de pagos (MP también manda merchant_order, etc.).
  if (type !== 'payment') {
    logger.info({ type, paymentId }, 'MP webhook: tipo no manejado — ignorado');
    return { received: true };
  }

  // 1. Consultar el pago real (el webhook no trae el estado).
  let status;
  try {
    status = await gateway.getPaymentStatus(paymentId);
  } catch (err) {
    logger.error({ err, paymentId }, 'MP webhook: no se pudo consultar el pago — 200 para evitar reintentos infinitos');
    return { received: true };
  }

  // external_reference: "<concepto>:<refId>[:<pago_id>]" — el 3er segmento (si
  // existe) identifica el pago EXACTO; el formato de 2 segmentos es legacy.
  const externalReference = (status.rawResponse as { external_reference?: string | null }).external_reference ?? '';
  const refParts = externalReference.split(':');
  const concepto = refParts[0] ?? '';
  const refId = refParts[1] ?? '';
  const pagoIdRef = refParts[2] ?? '';

  // 2. Mapear estado normalizado del adapter → estado del pago (solo terminales).
  const estadoMap: Record<string, EstadoPago | undefined> = {
    completed: 'completado',
    failed: 'fallido',
    cancelled: 'cancelado',
    refunded: 'reembolsado',
  };
  const targetEstado = estadoMap[status.status];
  if (!targetEstado && status.status !== 'pending') {
    logger.info({ paymentId, status: status.status }, 'MP webhook: estado no terminal — sin transición');
    return { received: true };
  }

  // 3a. Compra de créditos de estudios (no usa la tabla pagos).
  if (concepto === 'creditos_estudios') {
    if (targetEstado !== 'completado') return { received: true };
    try {
      const { data: compra } = await (supabase
        .from('compras_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
        .select('stripe_session_id')
        .eq('id', refId)
        .single();
      const sessionId = (compra as { stripe_session_id?: string } | null)?.stripe_session_id;
      if (!sessionId) {
        logger.warn({ refId, paymentId }, 'MP webhook: compra de créditos no encontrada');
        return { received: true };
      }
      const { acreditarCompraDesdeWebhook } = await import('@/modules/creditos-estudios/creditos-estudios.service');
      await acreditarCompraDesdeWebhook(sessionId, paymentId, status.rawResponse);
    } catch (err) {
      logger.error({ err, refId, paymentId }, 'MP webhook: error acreditando compra de créditos');
    }
    return { received: true };
  }

  // 3b. Localizar NUESTRO pago. Preferimos el match exacto por pago_id (3er
  // segmento de external_reference); el fallback legacy filtra también por
  // concepto — sin eso, pagar el estudio podía "completar" la garantía.
  if (!refId && !pagoIdRef) {
    logger.warn({ paymentId, externalReference }, 'MP webhook: external_reference sin expediente — ignorado');
    await registrarPagoNoConciliado(paymentId, externalReference, status, 'referencia_desconocida');
    return { received: true };
  }

  type PagoLookup = { id: string; estado: string; monto: number | string | null; expediente_id: string | null; transaction_ref: string | null };
  let pago: PagoLookup | null = null;

  if (pagoIdRef) {
    const { data } = await (supabase
      .from('pagos' as string) as ReturnType<typeof supabase.from>)
      .select('id, estado, monto, expediente_id, transaction_ref')
      .eq('id', pagoIdRef)
      .maybeSingle();
    pago = data as PagoLookup | null;
    if (pago && refId && pago.expediente_id !== refId) {
      logger.error({ paymentId, pagoIdRef, refId }, 'MP webhook: pago_id no corresponde al expediente de la referencia');
      await registrarPagoNoConciliado(paymentId, externalReference, status, 'pago_id_expediente_mismatch');
      return { received: true };
    }
  }

  if (!pago) {
    // Legacy: preferences emitidas antes de codificar pago_id en la referencia.
    const { data: pagoRow } = await (supabase
      .from('pagos' as string) as ReturnType<typeof supabase.from>)
      .select('id, estado, monto, expediente_id, transaction_ref')
      .eq('expediente_id', refId)
      .eq('concepto', concepto)
      .eq('metodo', 'pasarela')
      .in('estado', ['pendiente', 'procesando', 'completado'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    pago = pagoRow as PagoLookup | null;
  }

  if (!pago) {
    logger.error({ expedienteId: refId, paymentId, concepto }, 'MP webhook: pago no encontrado — dinero sin conciliar');
    // El dinero entró a MP pero no hay pago casable (link cancelado pagado,
    // referencia vieja). Queda registrado para reembolso/conciliación manual.
    if (status.status === 'completed') {
      await registrarPagoNoConciliado(paymentId, externalReference, status, 'pago_no_encontrado');
    }
    return { received: true };
  }

  // 3c. Estado no terminal 'pending' (PSE/efectivo): persistir el payment_id y
  // pasar a 'procesando' para que la reconciliación periódica pueda seguirlo.
  if (!targetEstado) {
    if (pago.estado === 'pendiente') {
      try {
        await transitionPagoStateChecked({
          pagoId: pago.id,
          targetEstado: 'procesando',
          origen: 'webhook',
          detalles: { provider: 'mercadopago', mp_payment_id: paymentId, mp_status: 'pending' },
          extraUpdate: { transaction_ref: status.transactionRef, gateway_response: status.rawResponse },
        });
      } catch (err) {
        logger.warn({ err, pagoId: pago.id }, 'MP webhook: no se pudo marcar procesando (pending)');
      }
    }
    return { received: true };
  }

  // 3d. Validar el monto antes de completar: un pago aprobado por un monto
  // distinto al nuestro NO debe marcar el pago como completado.
  const mpAmount = (status.rawResponse as { transaction_amount?: number }).transaction_amount;
  if (
    targetEstado === 'completado'
    && typeof mpAmount === 'number'
    && pago.monto != null
    && Number(pago.monto) !== mpAmount
  ) {
    logger.error(
      { paymentId, pagoId: pago.id, esperado: Number(pago.monto), recibido: mpAmount },
      'MP webhook: monto del pago no coincide — NO se completa (queda para conciliación manual)',
    );
    await registrarPagoNoConciliado(paymentId, externalReference, status, 'amount_mismatch');
    return { received: true };
  }

  if (pago.estado === targetEstado) {
    // Doble cobro: un SEGUNDO payment aprobado sobre un pago ya completado
    // (reintento del comprador) no debe desaparecer en el skip — se registra
    // para reembolso manual. El upsert idempotente absorbe los retries del
    // MISMO payment sin duplicar.
    if (
      targetEstado === 'completado'
      && status.transactionRef
      && pago.transaction_ref
      && status.transactionRef !== pago.transaction_ref
    ) {
      logger.error(
        { pagoId: pago.id, paymentId, previo: pago.transaction_ref },
        'MP webhook: pago duplicado (segundo payment aprobado sobre pago completado) — registrado para reembolso',
      );
      await registrarPagoNoConciliado(paymentId, externalReference, status, 'pago_duplicado');
      return { received: true };
    }
    logger.info({ pagoId: pago.id, estado: targetEstado }, 'MP webhook: pago ya en estado objetivo — idempotent skip');
    return { received: true };
  }

  // Pre-check: dinero aprobado sobre un pago en estado sin camino a 'completado'
  // (cancelado/reembolsado) NO debe perderse en un error de transición — queda
  // registrado para conciliación/reembolso manual.
  if (targetEstado === 'completado' && !isValidTransition(pago.estado as EstadoPago, 'completado')) {
    logger.error(
      { pagoId: pago.id, paymentId, estadoActual: pago.estado },
      'MP webhook: payment aprobado sobre pago no completable — registrado para conciliación',
    );
    await registrarPagoNoConciliado(paymentId, externalReference, status, 'transicion_invalida');
    return { received: true };
  }

  // 3e. Transición atómica (CAS): si webhook y reconciliación llegan a la vez,
  // solo UNA gana `transitioned=true` — el dispatch corre exactamente una vez.
  let transitioned = false;
  try {
    const result = await transitionPagoStateChecked({
      pagoId: pago.id,
      targetEstado,
      origen: 'webhook',
      detalles: { provider: 'mercadopago', mp_payment_id: paymentId, transaction_ref: status.transactionRef },
      extraUpdate: { transaction_ref: status.transactionRef, gateway_response: status.rawResponse },
    });
    transitioned = result.transitioned;
  } catch (err) {
    logger.error({ err, pagoId: pago.id }, 'MP webhook: error en transición de estado');
    // Backstop: si era dinero aprobado (carrera TOCTOU, índice único, etc.),
    // que no se pierda sin rastro.
    if (status.status === 'completed') {
      await registrarPagoNoConciliado(paymentId, externalReference, status, 'transicion_fallida');
    }
    return { received: true };
  }

  // 4. Dispatch al orquestador SOLO en la transición efectiva a completado.
  if (targetEstado === 'completado' && transitioned) {
    await dispatchPagoCompletado(pago.id);
  }

  return { received: true };
}

/**
 * Registra un pago del proveedor que no se pudo conciliar con un pago en BD
 * (link cancelado pagado, monto distinto, referencia desconocida). Idempotente
 * por (proveedor, provider_payment_id) — los retries del webhook no duplican.
 */
async function registrarPagoNoConciliado(
  paymentId: string,
  externalReference: string,
  status: { status: string; rawResponse: Record<string, unknown> },
  motivo: string,
): Promise<void> {
  const mpAmount = (status.rawResponse as { transaction_amount?: number }).transaction_amount;
  const { error } = await (supabase
    .from('pagos_no_conciliados' as string) as ReturnType<typeof supabase.from>)
    .upsert(
      {
        proveedor: 'mercadopago',
        provider_payment_id: paymentId,
        external_reference: externalReference || null,
        monto: typeof mpAmount === 'number' ? mpAmount : null,
        estado_proveedor: status.status,
        motivo,
        raw_response: status.rawResponse,
      } as never,
      { onConflict: 'proveedor,provider_payment_id', ignoreDuplicates: true } as never,
    );
  if (error) {
    logger.error({ error: error.message, paymentId, motivo }, 'No se pudo registrar el pago no conciliado');
  }
}

/**
 * Reconciliación periódica: pagos pasarela que llevan rato en pendiente o
 * procesando (PSE/efectivo, o webhooks que nunca llegaron). Busca en MP por
 * external_reference y procesa cada payment encontrado por la misma vía
 * idempotente del webhook. Pensada para correr en un setInterval del server.
 */
export async function reconcilePendingPagos(): Promise<{ revisados: number; conciliados: number }> {
  const gateway = getPaymentGateway();
  if (gateway.provider !== 'mercadopago' || !gateway.searchPaymentsByReference) {
    return { revisados: 0, conciliados: 0 };
  }

  const desde = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const hasta = new Date(Date.now() - 15 * 60 * 1000).toISOString(); // deja respirar a los recién creados

  // Incluye 'fallido': MP permite reintentar en el mismo checkout — si el
  // reintento fue APROBADO y su webhook se perdió, el job lo rescata
  // (fallido→completado es transición válida).
  const { data, error } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .select('id, expediente_id, concepto, estado, transaction_ref, created_at')
    .eq('metodo', 'pasarela')
    .in('estado', ['pendiente', 'procesando', 'fallido'])
    .gte('created_at', desde)
    .lte('created_at', hasta)
    .limit(50);

  if (error) {
    logger.error({ error: error.message }, 'reconcilePendingPagos: error consultando pagos');
    return { revisados: 0, conciliados: 0 };
  }

  const pendientes = (data ?? []) as Array<{
    id: string; expediente_id: string; concepto: string; estado: string; transaction_ref: string | null;
  }>;

  let conciliados = 0;
  for (const p of pendientes) {
    try {
      // SIEMPRE buscar por referencia (no solo el transaction_ref guardado): un
      // checkout de MP admite varios intentos — el transaction_ref puede ser de
      // un intento rechazado mientras un reintento posterior fue APROBADO.
      const ref = `${p.concepto}:${p.expediente_id}:${p.id}`;
      let found = await gateway.searchPaymentsByReference(ref);
      if (found.length === 0) {
        // Legacy: preferences sin pago_id en la referencia.
        found = await gateway.searchPaymentsByReference(`${p.concepto}:${p.expediente_id}`);
      }
      if (found.length === 0 && p.transaction_ref) {
        // Fallback: consultar el payment conocido (quedó de un webhook 'pending').
        await processMercadoPagoWebhook(p.transaction_ref, 'payment', gateway);
      } else {
        // Procesar primero los aprobados: así el pago llega a 'completado' antes
        // de que un intento rechazado lo mande a 'fallido'.
        const ordenados = [...found].sort((a, b) =>
          (a.status === 'completed' ? -1 : 0) - (b.status === 'completed' ? -1 : 0),
        );
        for (const payment of ordenados) {
          if (payment.transactionRef) {
            await processMercadoPagoWebhook(payment.transactionRef, 'payment', gateway);
          }
        }
      }
      const { data: after } = await (supabase
        .from('pagos' as string) as ReturnType<typeof supabase.from>)
        .select('estado')
        .eq('id', p.id)
        .single();
      if ((after as { estado?: string } | null)?.estado !== p.estado) conciliados += 1;
    } catch (err) {
      logger.warn({ err, pagoId: p.id }, 'reconcilePendingPagos: error reconciliando pago');
    }
  }

  // Compras de créditos pendientes (no viven en `pagos`): mismo rescate por
  // external_reference — sin esto, una compra pagada sin webhook quedaba
  // 'pendiente' para siempre y los créditos nunca se acreditaban.
  const { data: comprasData, error: comprasError } = await (supabase
    .from('compras_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, created_at')
    .eq('estado', 'pendiente')
    .gte('created_at', desde)
    .lte('created_at', hasta)
    .limit(50);

  if (comprasError) {
    logger.error({ error: comprasError.message }, 'reconcilePendingPagos: error consultando compras de créditos');
  }

  const compras = (comprasData ?? []) as Array<{ id: string; estado: string }>;
  let comprasConciliadas = 0;
  for (const c of compras) {
    try {
      const found = await gateway.searchPaymentsByReference(`creditos_estudios:${c.id}`);
      for (const payment of found) {
        if (payment.transactionRef) {
          await processMercadoPagoWebhook(payment.transactionRef, 'payment', gateway);
        }
      }
      const { data: after } = await (supabase
        .from('compras_creditos_estudios' as string) as ReturnType<typeof supabase.from>)
        .select('estado')
        .eq('id', c.id)
        .single();
      if ((after as { estado?: string } | null)?.estado === 'completado') comprasConciliadas += 1;
    } catch (err) {
      logger.warn({ err, compraId: c.id }, 'reconcilePendingPagos: error reconciliando compra de créditos');
    }
  }

  if (pendientes.length > 0 || compras.length > 0) {
    logger.info(
      { revisados: pendientes.length, conciliados, comprasRevisadas: compras.length, comprasConciliadas },
      'reconcilePendingPagos: ciclo terminado',
    );
  }
  return { revisados: pendientes.length + compras.length, conciliados: conciliados + comprasConciliadas };
}

/**
 * Reconciliación: confirma un pago consultándolo directo en la pasarela, SIN
 * depender de que llegue el webhook. La usa la página pública de resultado tras
 * el retorno del comprador (MP redirige con el payment_id). Así el pago se
 * confirma aunque el webhook nunca llegue (red de seguridad). Reusa la lógica
 * del webhook, que es idempotente (si ya está completado, no hace nada).
 */
export async function reconcileMercadoPagoPayment(paymentId: string): Promise<void> {
  const gateway = getPaymentGateway();
  if (gateway.provider !== 'mercadopago') return;
  await processMercadoPagoWebhook(paymentId, 'payment', gateway);
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

// ============================================================
// Notificacion in-app del pago completado
// ============================================================

/**
 * Notifica al solicitante que su pago fue confirmado. Resolucion de userId
 * por email (perfiles no almacena email — vive en auth.users). Tolera la
 * ausencia del perfil silenciosamente.
 */
async function notificarSolicitantePagoCompletado(
  pagoId: string,
  expedienteId: string,
  concepto: string,
): Promise<void> {
  const { data: exp } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id, numero, solicitante_id')
    .eq('id', expedienteId)
    .single() as { data: { id: string; numero: string | null; solicitante_id: string | null } | null };

  if (!exp?.solicitante_id) return;

  const { data: sol } = await (supabase
    .from('solicitantes' as string) as ReturnType<typeof supabase.from>)
    .select('email')
    .eq('id', exp.solicitante_id)
    .single() as { data: { email: string } | null };

  const userId = await findPerfilIdByEmail(sol?.email);
  if (!userId) return;

  const titulo = concepto === 'estudio' ? 'Pago del estudio confirmado' : 'Pago confirmado';
  const mensaje = concepto === 'estudio'
    ? `Recibimos tu pago. Iniciamos el estudio crediticio de la solicitud ${exp.numero ?? ''}.`
    : `Tu pago de la solicitud ${exp.numero ?? ''} fue confirmado.`;

  await notificarUsuario({
    userId,
    tipo: 'pago.confirmado',
    titulo,
    mensaje,
    link: `/expedientes/${expedienteId}`,
    payload: { pago_id: pagoId, expediente_id: expedienteId, concepto },
  });
}
