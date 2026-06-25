/**
 * Pago Estudio Service (HP-353)
 *
 * Orchestrates the study payment flow:
 * - Option 1: Inmobiliaria assumes cost (internal registration)
 * - Option 2: Send payment link to tenant via email
 */

import crypto from 'node:crypto';
import { supabase } from '@/lib/supabase';
import { AppError, fromSupabaseError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { env } from '@/config';
import { sendPaymentLinkEmail } from '@/lib/email';
import { getPaymentGateway } from '@/modules/pagos/gateway';
import { transitionPagoState } from '@/modules/pagos/pago-state-machine';
import { attachFacturas } from '@/modules/pagos/pagos.service';
import { notificarUsuario, findPerfilIdByEmail } from '@/modules/notificaciones/notificaciones.service';
import { enviarTemplate } from '@/modules/whatsapp';
import type { EnviarLinkInput } from './pago-estudio.schema';

/**
 * WhatsApp con el link de pago al solicitante del expediente (refuerzo del
 * correo). Fire-and-forget: enviarTemplate ya traga errores y sin teléfono
 * simplemente no envía.
 */
async function enviarLinkPagoWhatsApp(expedienteId: string, montoFormateado: string, linkUrl: string) {
  const { data: exp } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('solicitante_id, solicitantes(nombre, telefono)')
    .eq('id', expedienteId)
    .maybeSingle();
  const sol = (exp as { solicitantes?: { nombre?: string | null; telefono?: string | null } } | null)?.solicitantes;
  await enviarTemplate({
    to: sol?.telefono ?? null,
    template: 'PAGO_ESTUDIO_LINK',
    variables: [sol?.nombre || 'Hola', montoFormateado, linkUrl],
    context: { expediente_id: expedienteId },
  });
}

// ============================================================
// Helpers
// ============================================================

const PAGO_SELECT = `
  id, expediente_id, concepto, descripcion, monto, moneda, metodo, estado,
  payment_link_url, external_id, email_pagador, nombre_pagador,
  fecha_pago, created_at, updated_at, creado_por
`;

async function getMontoEstudio(): Promise<number> {
  const { data, error } = await (supabase
    .from('configuracion_sistema' as string) as ReturnType<typeof supabase.from>)
    .select('valor')
    .eq('clave', 'monto_estudio')
    .single();

  if (error || !data) {
    logger.warn('monto_estudio not found in configuracion_sistema — using default 80000');
    return 80000;
  }

  return parseInt((data as { valor: string }).valor, 10) || 80000;
}

async function getExpedienteWithInmueble(expedienteId: string) {
  const { data, error } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id, numero, estado, inmueble_id')
    .eq('id', expedienteId)
    .single();

  if (error || !data) throw AppError.notFound('Expediente no encontrado');

  const exp = data as { id: string; numero: string; estado: string; inmueble_id: string | null };

  let inmuebleDireccion = '';
  if (exp.inmueble_id) {
    const { data: inmueble } = await (supabase
      .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
      .select('direccion, ciudad')
      .eq('id', exp.inmueble_id)
      .single();

    if (inmueble) {
      const inm = inmueble as { direccion: string; ciudad: string };
      inmuebleDireccion = `${inm.direccion}${inm.ciudad ? `, ${inm.ciudad}` : ''}`;
    }
  }

  return { ...exp, inmueble_direccion: inmuebleDireccion };
}

async function findPagoEstudio(expedienteId: string) {
  const { data } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .select(PAGO_SELECT)
    .eq('expediente_id', expedienteId)
    .eq('concepto', 'estudio')
    .not('estado', 'eq', 'cancelado')
    .order('created_at', { ascending: false })
    .limit(1);

  return (data && data.length > 0) ? data[0] as Record<string, unknown> : null;
}

function formatCOP(amount: number): string {
  return `$${amount.toLocaleString('es-CO')}`;
}

// ============================================================
// Get estado del pago del estudio
// ============================================================

export async function getEstadoPagoEstudio(expedienteId: string) {
  const monto = await getMontoEstudio();
  const pago = await findPagoEstudio(expedienteId);

  if (!pago) {
    return {
      estado: 'sin_definir',
      puede_avanzar: false,
      monto,
      moneda: 'COP',
      monto_formateado: formatCOP(monto),
      pago: null,
    };
  }

  const estado = pago.estado as string;
  const metodo = pago.metodo as string;

  // Adjuntar la factura emitida al pago para que el frontend pueda decidir
  // si mostrar "Facturar" vs "Ver factura" tras un refresh. Sin esto, el
  // boton "Facturar" reaparecia despues de emitir porque el local state
  // (facturaIdEmitida) se pierde al re-montar el componente.
  const [pagoConFactura] = await attachFacturas([pago as Record<string, unknown> & { id: string }]);

  return {
    estado: estado === 'completado' && metodo !== 'pasarela' ? 'asumido_inmobiliaria' : estado,
    puede_avanzar: estado === 'completado',
    monto: pago.monto as number,
    moneda: 'COP',
    monto_formateado: formatCOP(pago.monto as number),
    pago: pagoConFactura,
  };
}

/**
 * Expira el link en la pasarela (best-effort, fire-and-forget): un pago
 * cancelado en BD no debe seguir siendo pagable desde el email del arrendatario.
 */
function invalidarLinkPasarela(pago: { external_id?: string | null; metodo?: string | null }): void {
  if (pago.metodo !== 'pasarela' || !pago.external_id) return;
  const gateway = getPaymentGateway();
  if (!gateway.cancelPaymentLink) return;
  gateway
    .cancelPaymentLink(pago.external_id)
    .catch((err) =>
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), externalId: pago.external_id },
        'No se pudo expirar el link en la pasarela (el pago en BD ya quedó cancelado)',
      ),
    );
}

// ============================================================
// Inmobiliaria asume el costo — POST /asumir
// ============================================================

export async function asumirCosto(expedienteId: string, userId: string, ip?: string) {
  // Check no existing active pago
  const existing = await findPagoEstudio(expedienteId);
  if (existing && (existing.estado as string) === 'completado') {
    throw AppError.conflict('Ya existe un pago de estudio completado para este expediente', 'PAGO_ESTUDIO_YA_COMPLETADO');
  }

  // Si hay un link de pago vivo, cancelarlo primero (BD + preference en la
  // pasarela): sin esto coexistirían dos pagos y el arrendatario podría pagar
  // el link viejo del email — dinero capturado sin pago casable.
  if (existing && ['pendiente', 'procesando'].includes(existing.estado as string)) {
    await transitionPagoState({
      pagoId: existing.id as string,
      targetEstado: 'cancelado',
      origen: 'manual',
      detalles: { cancelado_por: userId, motivo: 'inmobiliaria_asume_costo' },
      userId,
      ip,
    });
    invalidarLinkPasarela(existing as { external_id?: string | null; metodo?: string | null });
  }

  const exp = await getExpedienteWithInmueble(expedienteId);
  const monto = await getMontoEstudio();

  const { data: pago, error } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: expedienteId,
      concepto: 'estudio',
      descripcion: `Estudio de arrendamiento - ${exp.inmueble_direccion || `Exp. ${exp.numero}`} (asumido por inmobiliaria)`,
      monto,
      metodo: 'transferencia',
      estado: 'completado',
      fecha_pago: new Date().toISOString(),
      creado_por: userId,
    } as never)
    .select(PAGO_SELECT)
    .single();

  if (error) {
    if (error.code === '23505') {
      throw AppError.conflict('Ya existe un pago de estudio activo para este expediente', 'PAGO_ESTUDIO_PENDIENTE');
    }
    logger.error({ error: error.message }, 'Error registering inmobiliaria-assumed estudio payment');
    throw fromSupabaseError(error);
  }

  // Record event
  await (supabase
    .from('eventos_pago' as string) as ReturnType<typeof supabase.from>)
    .insert({
      pago_id: pago.id,
      tipo: 'completed',
      origen: 'manual',
      detalles: { metodo: 'inmobiliaria_asume', registrado_por: userId },
    } as never);

  // Timeline entry
  await (supabase
    .from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: expedienteId,
      tipo: 'pago',
      descripcion: 'Pago de estudio asumido por la inmobiliaria',
      metadata: { pago_id: pago.id, concepto: 'estudio', metodo: 'inmobiliaria_asume', evento: 'pago_confirmado', origen: 'system' },
      usuario_id: userId,
    } as never);

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.PAGO_MANUAL_REGISTERED,
    entidad: AUDIT_ENTITIES.PAGO,
    entidadId: pago.id,
    detalle: { expediente_id: expedienteId, concepto: 'estudio', metodo: 'inmobiliaria_asume', monto },
    ip,
  });

  // Auto-enviar el link de autorización (habeas data) al inquilino, igual que el
  // flujo de pago por Stripe (que lo hace vía onPagoConfirmado). Best-effort y
  // fire-and-forget: no bloquea la respuesta ni rompe el registro del pago si
  // falla — queda el botón manual "Enviar autorización" como respaldo.
  import('@/modules/autorizaciones/autorizaciones.service')
    .then(({ enviarEnlaceAutorizacion }) => enviarEnlaceAutorizacion(expedienteId, userId))
    .then(() => logger.info({ expedienteId }, 'Link de autorización auto-enviado (inmobiliaria asume costo)'))
    .catch((err) =>
      logger.warn(
        { error: err instanceof Error ? err.message : String(err), expedienteId },
        'No se pudo auto-enviar el link de autorización tras asumir el costo (reenviable manualmente)',
      ),
    );

  return pago;
}

// ============================================================
// Enviar link de pago al arrendatario — POST /enviar-link
// ============================================================

export async function enviarLinkPago(
  expedienteId: string,
  input: EnviarLinkInput,
  userId: string,
  ip?: string,
) {
  // Check no existing active pago (pendiente or procesando)
  const existing = await findPagoEstudio(expedienteId);
  if (existing) {
    const estado = existing.estado as string;
    if (estado === 'completado') {
      throw AppError.conflict('Ya existe un pago de estudio completado', 'PAGO_ESTUDIO_YA_COMPLETADO');
    }
    if (estado === 'pendiente' || estado === 'procesando') {
      throw AppError.conflict('Ya existe un link de pago pendiente para este estudio', 'PAGO_ESTUDIO_PENDIENTE');
    }
  }

  const exp = await getExpedienteWithInmueble(expedienteId);
  const monto = await getMontoEstudio();
  const conceptLabel = `Estudio de arrendamiento - ${exp.inmueble_direccion || `Exp. ${exp.numero}`}`;

  // Build success/cancel/pending URLs (pending: PSE/efectivo no es éxito todavía)
  const successUrl = `${env.FRONTEND_URL}/pago/resultado?status=success&expediente=${expedienteId}`;
  const cancelUrl = `${env.FRONTEND_URL}/pago/resultado?status=cancelled&expediente=${expedienteId}`;
  const pendingUrl = `${env.FRONTEND_URL}/pago/resultado?status=pending&expediente=${expedienteId}`;

  // Insert pago ANTES de crear el checkout, con id pre-generado: la preference
  // lleva el pago_id en external_reference y el webhook casa el pago EXACTO.
  // El índice único uq_pagos_estudio_activo convierte la carrera de doble click
  // en un 23505 limpio en lugar de dos links vivos.
  const gateway = getPaymentGateway();
  const pagoId = crypto.randomUUID();
  const { error: insertError } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .insert({
      id: pagoId,
      expediente_id: expedienteId,
      concepto: 'estudio',
      descripcion: conceptLabel,
      monto,
      metodo: 'pasarela',
      estado: 'pendiente',
      email_pagador: input.email_pagador,
      nombre_pagador: input.nombre_pagador,
      creado_por: userId,
    } as never);

  if (insertError) {
    if (insertError.code === '23505') {
      throw AppError.conflict('Ya existe un pago de estudio activo para este expediente', 'PAGO_ESTUDIO_PENDIENTE');
    }
    logger.error({ error: insertError.message }, 'Error creating estudio payment record');
    throw fromSupabaseError(insertError);
  }

  let linkResult: { url: string; externalId: string };
  try {
    linkResult = await gateway.createPaymentLink({
      amount: monto,
      concept: conceptLabel,
      description: `Pago de estudio de arrendamiento para ${input.nombre_pagador}`,
      metadata: {
        expediente_id: expedienteId,
        concepto: 'estudio',
        email_pagador: input.email_pagador,
        pago_id: pagoId,
      },
      successUrl,
      cancelUrl,
      pendingUrl,
    });
  } catch (gatewayError) {
    // No dejar la fila huérfana bloqueando el índice único.
    await (supabase
      .from('pagos' as string) as ReturnType<typeof supabase.from>)
      .delete()
      .eq('id', pagoId);
    throw gatewayError;
  }

  // CAS sobre 'pendiente': si el pago fue cancelado concurrentemente (p. ej.
  // cancelar-y-asumir mientras se creaba el checkout), no se adjunta un link
  // pagable a un pago cancelado — se expira la preference y se aborta.
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
    logger.error({ error: error.message, pagoId }, 'Error guardando el link del estudio — se revierte');
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
    if (gateway.cancelPaymentLink) {
      gateway.cancelPaymentLink(linkResult.externalId).catch((err) =>
        logger.warn({ err, externalId: linkResult.externalId }, 'No se pudo expirar la preference tras cancelación concurrente'),
      );
    }
    throw AppError.conflict('El pago fue cancelado mientras se creaba el link', 'PAGO_CANCELADO_CONCURRENTE');
  }

  // Record events
  await (supabase
    .from('eventos_pago' as string) as ReturnType<typeof supabase.from>)
    .insert({
      pago_id: pago.id,
      tipo: 'created',
      origen: 'system',
      detalles: { gateway: gateway.provider, external_id: linkResult.externalId },
    } as never);

  // Send email
  try {
    await sendPaymentLinkEmail(
      input.email_pagador,
      input.nombre_pagador,
      linkResult.url,
      {
        concepto: 'Estudio de arrendamiento',
        monto: formatCOP(monto),
        expediente_numero: exp.numero,
      },
    );

    await (supabase
      .from('eventos_pago' as string) as ReturnType<typeof supabase.from>)
      .insert({
        pago_id: pago.id,
        tipo: 'link_sent',
        origen: 'system',
        detalles: { email: input.email_pagador },
      } as never);
  } catch (emailError) {
    logger.error({ emailError, pagoId: pago.id }, 'Error sending estudio payment email');
  }

  // WhatsApp con el link al solicitante (refuerzo del correo) — fire-and-forget.
  enviarLinkPagoWhatsApp(expedienteId, formatCOP(monto), linkResult.url).catch((err) =>
    logger.warn({ err, expedienteId }, 'No se pudo enviar el WhatsApp del link de pago'),
  );

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.PAGO_CREATED,
    entidad: AUDIT_ENTITIES.PAGO,
    entidadId: pago.id,
    detalle: { expediente_id: expedienteId, concepto: 'estudio', monto, email: input.email_pagador },
    ip,
  });

  // Notificacion in-app al solicitante: el link de pago esta listo. Si su
  // email matchea un perfil registrado, le aparece en la campana del panel.
  // Fire-and-forget — el email ya salio antes; esta es solo redundancia util.
  findPerfilIdByEmail(input.email_pagador).then((solicitanteUserId) => {
    if (!solicitanteUserId) return;
    return notificarUsuario({
      userId: solicitanteUserId,
      tipo: 'pago.disponible',
      titulo: 'Pago de estudio disponible',
      mensaje: `Ya puedes pagar el estudio crediticio (${formatCOP(monto)}). El pago habilita la consulta a TransUnion automáticamente.`,
      link: `/expedientes/${expedienteId}`,
      payload: { expediente_id: expedienteId, pago_id: pago.id },
    });
  }).catch((e) => logger.warn({ error: e, pagoId: pago.id }, 'Error notificando link de pago disponible'));

  return pago;
}

// ============================================================
// Reenviar link — POST /reenviar
// ============================================================

export async function reenviarLink(expedienteId: string, userId: string, ip?: string) {
  const pago = await findPagoEstudio(expedienteId);
  if (!pago) throw AppError.notFound('No existe un pago de estudio para este expediente');
  if ((pago.estado as string) !== 'pendiente') {
    throw AppError.badRequest('Solo se puede reenviar el link de pagos en estado pendiente', 'PAGO_NO_REENVIABLE');
  }
  if (!pago.payment_link_url || !pago.email_pagador) {
    throw AppError.badRequest('Este pago no tiene link o email asociado', 'NO_PAYMENT_LINK');
  }

  const exp = await getExpedienteWithInmueble(expedienteId);
  const monto = pago.monto as number;

  await sendPaymentLinkEmail(
    pago.email_pagador as string,
    (pago.nombre_pagador as string) || '',
    pago.payment_link_url as string,
    {
      concepto: 'Estudio de arrendamiento',
      monto: formatCOP(monto),
      expediente_numero: exp.numero,
    },
  );

  await (supabase
    .from('eventos_pago' as string) as ReturnType<typeof supabase.from>)
    .insert({
      pago_id: pago.id as string,
      tipo: 'link_sent',
      origen: 'system',
      detalles: { email: pago.email_pagador, reenviado_por: userId },
    } as never);

  // WhatsApp con el link al solicitante (refuerzo del correo) — fire-and-forget.
  enviarLinkPagoWhatsApp(expedienteId, formatCOP(monto), pago.payment_link_url as string).catch((err) =>
    logger.warn({ err, expedienteId }, 'No se pudo reenviar el WhatsApp del link de pago'),
  );

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.PAGO_LINK_RESENT,
    entidad: AUDIT_ENTITIES.PAGO,
    entidadId: pago.id as string,
    detalle: { email: pago.email_pagador },
    ip,
  });

  return { message: `Link reenviado a ${pago.email_pagador}` };
}

// ============================================================
// Cancelar link y asumir — POST /cancelar-y-asumir
// ============================================================

export async function cancelarYAsumir(expedienteId: string, userId: string, ip?: string) {
  const pago = await findPagoEstudio(expedienteId);
  if (!pago) throw AppError.notFound('No existe un pago de estudio pendiente');
  // 'procesando' también es cancelable: un PSE abandonado deja el pago ahí y la
  // inmobiliaria debe poder desbloquear el expediente sin esperar a MP.
  if (!['pendiente', 'procesando'].includes(pago.estado as string)) {
    throw AppError.badRequest('Solo se puede cancelar un pago en estado pendiente o en proceso', 'PAGO_NO_CANCELABLE');
  }

  // Cancel existing via state machine + expirar el link en la pasarela
  await transitionPagoState({
    pagoId: pago.id as string,
    targetEstado: 'cancelado',
    origen: 'manual',
    detalles: { cancelado_por: userId, motivo: 'inmobiliaria_asume_costo' },
    userId,
    ip,
  });
  invalidarLinkPasarela(pago as { external_id?: string | null; metodo?: string | null });

  // Create new completed payment
  return asumirCosto(expedienteId, userId, ip);
}

/**
 * Inmobiliaria: cancela el link pendiente y paga el estudio CONSUMIENDO UN
 * CRÉDITO (no "asume" gratis). Reusa liberarEstudioConCredito, que valida saldo,
 * crea el pago y auto-envía la autorización.
 */
export async function cancelarYLiberarCredito(expedienteId: string, userId: string, ip?: string) {
  const pago = await findPagoEstudio(expedienteId);
  if (!pago) throw AppError.notFound('No existe un pago de estudio pendiente');
  if (!['pendiente', 'procesando'].includes(pago.estado as string)) {
    throw AppError.badRequest('Solo se puede cancelar un pago en estado pendiente o en proceso', 'PAGO_NO_CANCELABLE');
  }

  // perfilId = userId: la inmobiliaria dueña del inmueble es dueña de los créditos.
  const { liberarEstudioConCredito, getSaldoCreditos } = await import('@/modules/creditos-estudios/creditos-estudios.service');

  // Verificar saldo ANTES de cancelar el link: sin esto, una inmobiliaria sin
  // créditos perdía el link ya enviado al arrendatario y quedaba sin pago.
  // Mejor fallar acá y dejar el link vivo (puede comprar paquete o que pague el arrendatario).
  const saldo = await getSaldoCreditos(userId);
  if (saldo.saldo_total < 1) {
    throw AppError.conflict(
      'No tienes créditos disponibles. Compra un paquete o deja que el arrendatario pague el link actual.',
      'SIN_CREDITOS',
    );
  }

  await transitionPagoState({
    pagoId: pago.id as string,
    targetEstado: 'cancelado',
    origen: 'manual',
    detalles: { cancelado_por: userId, motivo: 'inmobiliaria_libera_credito' },
    userId,
    ip,
  });
  invalidarLinkPasarela(pago as { external_id?: string | null; metodo?: string | null });

  return liberarEstudioConCredito(expedienteId, userId, userId, ip);
}

// ============================================================
// Public: resultado del pago
// ============================================================

export async function getResultadoPagoPublico(pagoId: string) {
  const { data, error } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .select('id, estado, concepto, monto, moneda, fecha_pago, expediente_id')
    .eq('id', pagoId)
    .single();

  if (error || !data) {
    throw AppError.notFound('Pago no encontrado');
  }

  const pago = data as { id: string; estado: string; concepto: string; monto: number; moneda: string; fecha_pago: string | null; expediente_id: string };

  // Get expediente numero (minimal, no sensitive data)
  const { data: exp } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('numero')
    .eq('id', pago.expediente_id)
    .single();

  return {
    id: pago.id,
    estado: pago.estado,
    concepto: pago.concepto,
    monto: pago.monto,
    moneda: pago.moneda,
    monto_formateado: formatCOP(pago.monto),
    fecha_pago: pago.fecha_pago,
    expediente_numero: (exp as { numero: string } | null)?.numero || null,
  };
}

/**
 * Reconciliación pública: tras volver del checkout, confirma el pago consultando
 * la pasarela con el payment_id (la pasarela lo pone en la URL de retorno). Es la
 * red de seguridad por si el webhook no llega — reusa la lógica del webhook, que
 * es idempotente. Import dinámico para evitar ciclos con pagos.service.
 */
export async function reconciliarPagoEstudio(paymentId: string): Promise<{ reconciliado: boolean }> {
  const { reconcileMercadoPagoPayment } = await import('@/modules/pagos/pagos.service');
  await reconcileMercadoPagoPayment(paymentId);
  return { reconciliado: true };
}
