/**
 * Pago Estudio Service (HP-353)
 *
 * Orchestrates the study payment flow:
 * - Option 1: Inmobiliaria assumes cost (internal registration)
 * - Option 2: Send payment link to tenant via email
 */

import { supabase } from '@/lib/supabase';
import { AppError, fromSupabaseError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { env } from '@/config';
import { sendPaymentLinkEmail } from '@/lib/email';
import { getPaymentGateway } from '@/modules/pagos/gateway';
import { transitionPagoState } from '@/modules/pagos/pago-state-machine';
import type { EnviarLinkInput } from './pago-estudio.schema';

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

  return {
    estado: estado === 'completado' && metodo !== 'pasarela' ? 'asumido_inmobiliaria' : estado,
    puede_avanzar: estado === 'completado',
    monto: pago.monto as number,
    moneda: 'COP',
    monto_formateado: formatCOP(pago.monto as number),
    pago,
  };
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
    .from('expediente_timeline' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: expedienteId,
      tipo: 'pago_confirmado',
      descripcion: 'Pago de estudio asumido por la inmobiliaria',
      detalle: { pago_id: pago.id, concepto: 'estudio', metodo: 'inmobiliaria_asume' },
      origen: 'system',
    } as never);

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.PAGO_MANUAL_REGISTERED,
    entidad: AUDIT_ENTITIES.PAGO,
    entidadId: pago.id,
    detalle: { expediente_id: expedienteId, concepto: 'estudio', metodo: 'inmobiliaria_asume', monto },
    ip,
  });

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

  // Build success/cancel URLs
  const successUrl = `${env.FRONTEND_URL}/pago/resultado?status=success&expediente=${expedienteId}`;
  const cancelUrl = `${env.FRONTEND_URL}/pago/resultado?status=cancelled&expediente=${expedienteId}`;

  // Create Stripe checkout session
  const gateway = getPaymentGateway();
  const linkResult = await gateway.createPaymentLink({
    amount: monto,
    concept: conceptLabel,
    description: `Pago de estudio de arrendamiento para ${input.nombre_pagador}`,
    metadata: {
      expediente_id: expedienteId,
      concepto: 'estudio',
      email_pagador: input.email_pagador,
    },
    successUrl,
    cancelUrl,
  });

  // Insert pago record
  const { data: pago, error } = await (supabase
    .from('pagos' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: expedienteId,
      concepto: 'estudio',
      descripcion: conceptLabel,
      monto,
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
    logger.error({ error: error.message }, 'Error creating estudio payment link');
    throw fromSupabaseError(error);
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

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.PAGO_CREATED,
    entidad: AUDIT_ENTITIES.PAGO,
    entidadId: pago.id,
    detalle: { expediente_id: expedienteId, concepto: 'estudio', monto, email: input.email_pagador },
    ip,
  });

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
  if ((pago.estado as string) !== 'pendiente') {
    throw AppError.badRequest('Solo se puede cancelar un pago en estado pendiente', 'PAGO_NO_CANCELABLE');
  }

  // Cancel existing via state machine
  await transitionPagoState({
    pagoId: pago.id as string,
    targetEstado: 'cancelado',
    origen: 'manual',
    detalles: { cancelado_por: userId, motivo: 'inmobiliaria_asume_costo' },
    userId,
    ip,
  });

  // Create new completed payment
  return asumirCosto(expedienteId, userId, ip);
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
