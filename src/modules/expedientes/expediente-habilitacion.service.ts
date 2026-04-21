import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { env } from '@/config/env';
import { sendEstudioHabilitadoEmail } from '../orchestrator/orchestrator.emails';
import { assertHabilitacionPermission } from './expediente-habilitacion.permissions';
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

  // 3. Email al solicitante. Error log-only para no abortar la habilitación.
  if (ctx.solicitanteEmail && ctx.solicitanteNombre) {
    try {
      // TODO(prompt-6): cambiar a `/expedientes/${id}/pagar-estudio`
      // cuando se implemente la pantalla de pago del estudio.
      const urlPanel = `${env.FRONTEND_URL}/expedientes/${expedienteId}`;
      await sendEstudioHabilitadoEmail({
        email: ctx.solicitanteEmail,
        nombre_solicitante: ctx.solicitanteNombre,
        expediente_numero: rpcResult.numero,
        inmueble: ctx.inmuebleDireccion,
        ciudad: ctx.inmuebleCiudad,
        url_panel: urlPanel,
      });
    } catch (emailError) {
      logger.warn(
        { error: emailError, expedienteId, estudioId: rpcResult.estudio_id },
        'Error al enviar email de habilitación de estudio',
      );
    }
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
