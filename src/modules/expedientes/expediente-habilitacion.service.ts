import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { env } from '@/config/env';
import { sendEstudioHabilitadoEmail } from '../orchestrator/orchestrator.emails';
import { assertHabilitacionPermission } from './expediente-habilitacion.permissions';
import { enviarLinkPago } from '../pago-estudio/pago-estudio.service';
import type { UserRole } from '@/types/auth';

export interface HabilitarEstudioResult {
  expediente: {
    id: string;
    numero: string;
    estudio_habilitado: true;
  };
  estudio: {
    id: string;
    estado: 'solicitado';
    resultado: 'pendiente';
  };
}

/**
 * Paso 3 del flujo de Cofianza: habilitar el estudio crediticio para un
 * expediente tras la cita realizada. Crea el registro placeholder en
 * `estudios` y notifica al solicitante. La mutación DB es atómica vía
 * RPC fn_habilitar_estudio_expediente.
 */
export async function habilitarEstudio(
  expedienteId: string,
  userId: string,
  userRol: string,
): Promise<HabilitarEstudioResult> {
  // 1. Ownership + datos del expediente para el email posterior.
  const ctx = await assertHabilitacionPermission({
    userId,
    userRol: userRol as UserRole,
    expedienteId,
  });

  // 2. RPC atómico: UPDATE expediente + INSERT estudio + INSERT timeline.
  //    Las validaciones (existencia, idempotencia, estado, cita realizada)
  //    viven en el RPC y vienen como mensajes de RAISE EXCEPTION que aquí
  //    se mapean a códigos HTTP específicos.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc('fn_habilitar_estudio_expediente', {
    p_expediente_id: expedienteId,
    p_user_id: userId,
  });

  if (error) {
    const msg = (error.message || '') as string;
    if (msg.includes('no encontrado')) {
      throw AppError.notFound('Expediente no encontrado');
    }
    if (msg.includes('ya habilitado')) {
      throw AppError.conflict(
        'El estudio ya fue habilitado para este expediente',
        'ESTUDIO_YA_HABILITADO',
      );
    }
    if (msg.includes('Estado no permitido')) {
      throw AppError.badRequest(msg, 'INVALID_STATE');
    }
    if (msg.includes('cita realizada')) {
      throw AppError.badRequest(
        'Se requiere al menos una cita realizada antes de habilitar el estudio',
        'CITA_REQUERIDA',
      );
    }
    logger.error({ error, expedienteId }, 'Error al habilitar estudio');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al habilitar el estudio');
  }

  const rpcResult = data as { expediente_id: string; numero: string; estudio_id: string };

  // 3. Notificación + pago.
  //    - Propietario habilita: auto-creamos Stripe Checkout Session y dejamos
  //      el pago pendiente para que el solicitante pague desde su panel/email.
  //      El email con el link de pago lo envía enviarLinkPago(), así que
  //      omitimos el email genérico de "habilitado" para no duplicar.
  //    - Admin/inmobiliaria: mantienen el flujo manual (enviar-link / asumir),
  //      así que solo enviamos el email informativo de habilitación.
  const puedeAutoCrearPago =
    userRol === 'propietario' &&
    !!ctx.solicitanteEmail &&
    !!ctx.solicitanteNombre;

  if (puedeAutoCrearPago) {
    try {
      await enviarLinkPago(
        expedienteId,
        {
          email_pagador: ctx.solicitanteEmail!,
          nombre_pagador: ctx.solicitanteNombre!,
        },
        userId,
      );
      logger.info(
        { expedienteId, estudioId: rpcResult.estudio_id },
        'Pago de estudio auto-creado tras habilitación por propietario',
      );
    } catch (pagoError) {
      // Si Stripe falla, caemos al email genérico para que el solicitante
      // al menos sepa que el estudio fue habilitado y pueda intentar desde
      // el panel (futuro: self-service).
      logger.warn(
        { error: pagoError, expedienteId, estudioId: rpcResult.estudio_id },
        'Error al auto-crear pago de estudio post-habilitación',
      );
      await sendHabilitadoFallbackEmail(expedienteId, rpcResult.numero, ctx);
    }
  } else if (ctx.solicitanteEmail && ctx.solicitanteNombre) {
    await sendHabilitadoFallbackEmail(expedienteId, rpcResult.numero, ctx);
  } else {
    // Escenario borde: expediente sin solicitante vinculado (source='invitacion'
    // con estudio_habilitado=false que se habilita manualmente). No hay a quién
    // notificar hasta que el token se canjee.
    logger.warn(
      { expedienteId, source: ctx.source },
      'Expediente habilitado sin solicitante asociado — email omitido',
    );
  }

  logger.info(
    {
      userId,
      userRol,
      expedienteId,
      estudioId: rpcResult.estudio_id,
      numero: rpcResult.numero,
    },
    'Estudio habilitado exitosamente',
  );

  return {
    expediente: {
      id: rpcResult.expediente_id,
      numero: rpcResult.numero,
      estudio_habilitado: true,
    },
    estudio: {
      id: rpcResult.estudio_id,
      estado: 'solicitado',
      resultado: 'pendiente',
    },
  };
}

/**
 * Email genérico "estudio habilitado" — usado cuando NO se auto-crea el pago
 * (admin/inmobiliaria) o como fallback si la creación del link Stripe falla.
 */
async function sendHabilitadoFallbackEmail(
  expedienteId: string,
  numero: string,
  ctx: { solicitanteEmail: string | null; solicitanteNombre: string | null; inmuebleDireccion: string; inmuebleCiudad: string },
): Promise<void> {
  if (!ctx.solicitanteEmail || !ctx.solicitanteNombre) return;
  try {
    const urlPanel = `${env.FRONTEND_URL}/expedientes/${expedienteId}`;
    await sendEstudioHabilitadoEmail({
      email: ctx.solicitanteEmail,
      nombre_solicitante: ctx.solicitanteNombre,
      expediente_numero: numero,
      inmueble: ctx.inmuebleDireccion,
      ciudad: ctx.inmuebleCiudad,
      url_panel: urlPanel,
    });
  } catch (emailError) {
    logger.warn(
      { error: emailError, expedienteId },
      'Error al enviar email de habilitación de estudio (fallback)',
    );
  }
}
