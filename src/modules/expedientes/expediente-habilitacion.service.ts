import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { env } from '@/config/env';
import {
  sendEstudioHabilitadoEmail,
  sendEstudioNoHabilitadoEmail,
  sendEstudioAprobadoEmail,
} from '../orchestrator/orchestrator.emails';
import { assertHabilitacionPermission } from './expediente-habilitacion.permissions';
import { enviarLinkPago } from '../pago-estudio/pago-estudio.service';
import { notificarUsuario, findPerfilIdByEmail } from '../notificaciones/notificaciones.service';
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
 *
 * No recibe datos del contrato (duracion + fecha): esos no son necesarios
 * para correr el estudio crediticio. Se piden solo cuando se va a generar
 * el contrato — post-aprobacion — via aprobarCondicionado() o
 * generarContratoExpediente().
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

  // Notificacion in-app al solicitante. Independiente del email — el solicitante
  // entra al panel y ve la campana con "Tu estudio fue habilitado". Fire-and-forget.
  if (ctx.solicitanteEmail) {
    findPerfilIdByEmail(ctx.solicitanteEmail).then((solicitanteUserId) => {
      if (!solicitanteUserId) return;
      return notificarUsuario({
        userId: solicitanteUserId,
        tipo: 'estudio.habilitado',
        titulo: '¡Tu estudio fue habilitado!',
        mensaje: puedeAutoCrearPago
          ? `El propietario habilitó tu estudio crediticio. Realiza el pago para continuar con la evaluación.`
          : `El propietario habilitó tu estudio crediticio. Recibirás el link de pago en breve.`,
        link: `/expedientes/${expedienteId}`,
        payload: { expediente_id: expedienteId, estudio_id: rpcResult.estudio_id },
      });
    }).catch((e) => logger.warn({ error: e, expedienteId }, 'Error notificando estudio habilitado'));
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
 * Caso opuesto a habilitarEstudio: el propietario, tras la visita, decide
 * NO proceder con este candidato. Marca el expediente como rechazado para
 * el flujo de estudio y notifica al solicitante por email + in-app.
 *
 * Validaciones:
 *   - El expediente debe existir y ser accesible para el propietario.
 *   - No debe haber un estudio ya habilitado (no se puede revertir).
 *   - Idempotente: si ya estaba rechazado, devuelve el estado actual sin error.
 */
export async function rechazarEstudio(
  expedienteId: string,
  motivo: string | undefined,
  userId: string,
  userRol: string,
): Promise<{ expediente: { id: string; numero: string; estudio_rechazado: true; motivo: string | null } }> {
  // 1. Verificar permisos (mismo guard que habilitar — solo propietario/inmobiliaria/admin/operador).
  const ctx = await assertHabilitacionPermission({
    userId,
    userRol: userRol as UserRole,
    expedienteId,
  });

  // 2. Releer estado actual: si ya fue habilitado o rechazado, decide.
  const { data: current } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id, numero, estudio_habilitado, estudio_rechazado')
    .eq('id', expedienteId)
    .single() as { data: { id: string; numero: string; estudio_habilitado: boolean; estudio_rechazado: boolean } | null };

  if (!current) {
    throw AppError.notFound('Expediente no encontrado');
  }
  if (current.estudio_habilitado) {
    throw AppError.conflict(
      'No se puede rechazar el estudio porque ya fue habilitado',
      'ESTUDIO_YA_HABILITADO',
    );
  }
  if (current.estudio_rechazado) {
    // Idempotente — devolvemos lo que ya esta.
    return {
      expediente: {
        id: current.id,
        numero: current.numero,
        estudio_rechazado: true,
        motivo: motivo ?? null,
      },
    };
  }

  // 3. Update + timeline.
  const motivoNorm = motivo?.trim() ? motivo.trim() : null;
  const { error: updErr } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .update({
      estudio_rechazado: true,
      motivo_estudio_rechazado: motivoNorm,
      estudio_rechazado_at: new Date().toISOString(),
      estudio_rechazado_por: userId,
      updated_at: new Date().toISOString(),
    } as never)
    .eq('id', expedienteId);

  if (updErr) {
    logger.error({ error: updErr.message, expedienteId }, 'Error al marcar estudio rechazado');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al rechazar el estudio');
  }

  await (supabase
    .from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: expedienteId,
      tipo: 'estudio',
      descripcion: motivoNorm
        ? `Propietario decidio no habilitar estudio. Motivo: ${motivoNorm}`
        : 'Propietario decidio no habilitar estudio tras la visita.',
      metadata: { motivo: motivoNorm },
    } as never);

  // 4. Notificar al solicitante (email + in-app). Fire-and-forget.
  if (ctx.solicitanteEmail && ctx.solicitanteNombre) {
    sendEstudioNoHabilitadoEmail({
      email: ctx.solicitanteEmail,
      nombre_solicitante: ctx.solicitanteNombre,
      expediente_numero: current.numero,
      inmueble: ctx.inmuebleDireccion,
      ciudad: ctx.inmuebleCiudad,
      motivo: motivoNorm,
    }).catch((e) => logger.warn({ error: e, expedienteId }, 'Error enviando email estudio no habilitado'));
  }

  if (ctx.solicitanteEmail) {
    findPerfilIdByEmail(ctx.solicitanteEmail).then((solicitanteUserId) => {
      if (!solicitanteUserId) return;
      return notificarUsuario({
        userId: solicitanteUserId,
        tipo: 'estudio.rechazado',
        titulo: 'El propietario no continuara con tu solicitud',
        mensaje: motivoNorm
          ? `Tras la visita a ${ctx.inmuebleDireccion}, el propietario decidio no habilitar el estudio. Motivo: ${motivoNorm}`
          : `Tras la visita a ${ctx.inmuebleDireccion}, el propietario decidio no habilitar el estudio.`,
        link: `/expedientes/${expedienteId}`,
        payload: { expediente_id: expedienteId, motivo: motivoNorm },
      });
    }).catch((e) => logger.warn({ error: e, expedienteId }, 'Error notificando estudio rechazado'));
  }

  logger.info({ expedienteId, userId, motivo: motivoNorm }, 'Estudio rechazado por propietario');

  return {
    expediente: {
      id: current.id,
      numero: current.numero,
      estudio_rechazado: true,
      motivo: motivoNorm,
    },
  };
}

/**
 * Aprobar manualmente un expediente que el buró dejó condicionado.
 *
 * Flujo: cuando TransUnion devuelve resultado='condicionado', el orchestrator
 * NO genera contrato automáticamente — espera a que el propietario revise la
 * documentación adicional y decida si procede. Este endpoint es la salida:
 * el propietario, tras revisar lo que pidió (codeudor, póliza, etc.),
 * confirma que sí quiere proceder y captura los datos del contrato (duración
 * + fecha de inicio). Transicionamos expediente a 'aprobado' y disparamos la
 * generación del contrato.
 *
 * Ownership: solo propietario/inmobiliaria del inmueble (más admin/operador
 * por defecto). El estudio.resultado se queda en 'condicionado' como reflejo
 * de lo que el buró dijo — solo cambia el estado del expediente.
 */
export async function aprobarCondicionado(
  expedienteId: string,
  userId: string,
  userRol: string,
  datosContrato: { duracion_contrato_meses: number; fecha_inicio_contrato: string },
): Promise<{
  expediente: { id: string; numero: string; estado: 'aprobado' };
  contrato_id: string | null;
}> {
  return await aprobarYGenerarContrato({
    expedienteId,
    userId,
    userRol,
    datosContrato,
    fromState: 'condicionado',
  });
}

/**
 * Para el flujo "estudio aprobado por el buró": antes el orchestrator
 * auto-generaba el contrato con defaults (12 meses + hoy). Mario pidió
 * (5-may-2026) que la duración + fecha la decida el propietario justo
 * antes de generar el contrato, no antes del estudio. Por eso ahora el
 * orchestrator solo deja el expediente en 'aprobado' SIN contrato y este
 * endpoint es el que dispara la generación con los datos elegidos.
 *
 * Idempotente parcial: si ya existe un contrato activo para el expediente,
 * el service de contratos lo detecta y aborta — el caller debe revisar
 * antes de llamar.
 */
export async function generarContratoExpediente(
  expedienteId: string,
  userId: string,
  userRol: string,
  datosContrato: { duracion_contrato_meses: number; fecha_inicio_contrato: string },
): Promise<{
  expediente: { id: string; numero: string; estado: 'aprobado' };
  contrato_id: string | null;
}> {
  return await aprobarYGenerarContrato({
    expedienteId,
    userId,
    userRol,
    datosContrato,
    fromState: 'aprobado', // el expediente ya está aprobado, solo generamos el contrato
  });
}

/**
 * Implementación común de "aprobar (si hace falta) y generar contrato".
 * Centraliza el chequeo de ownership, la transición de estado opcional,
 * el persistence de duración/fecha en expedientes y la llamada a
 * generarContrato — para no repetir lógica entre los dos flujos.
 */
async function aprobarYGenerarContrato(params: {
  expedienteId: string;
  userId: string;
  userRol: string;
  datosContrato: { duracion_contrato_meses: number; fecha_inicio_contrato: string };
  fromState: 'condicionado' | 'aprobado';
}): Promise<{
  expediente: { id: string; numero: string; estado: 'aprobado' };
  contrato_id: string | null;
}> {
  const { expedienteId, userId, userRol, datosContrato, fromState } = params;

  // 1. Ownership + datos para emails / contrato.
  const ctx = await assertHabilitacionPermission({
    userId,
    userRol: userRol as UserRole,
    expedienteId,
  });

  if (ctx.estado !== fromState) {
    const expected = fromState === 'condicionado'
      ? 'condicionado'
      : 'aprobado (sin contrato generado)';
    throw AppError.badRequest(
      `Estado de expediente invalido para esta accion. Esperado: ${expected}. Actual: ${ctx.estado}.`,
      'INVALID_STATE',
    );
  }

  const nowIso = new Date().toISOString();

  // 2. Persistir datos del contrato en el expediente (para auditoría +
  //    re-generación). Aún no transicionamos estado — eso depende del flujo.
  const { error: persistErr } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .update({
      duracion_contrato_meses: datosContrato.duracion_contrato_meses,
      fecha_inicio_contrato: datosContrato.fecha_inicio_contrato,
      updated_at: nowIso,
    } as never)
    .eq('id', expedienteId);

  if (persistErr) {
    logger.error({ error: persistErr.message, expedienteId }, 'Error al guardar datos del contrato en expediente');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al guardar los datos del contrato');
  }

  // 3. Transición condicionado → aprobado (solo si venía de condicionado).
  if (fromState === 'condicionado') {
    const { error: updErr } = await (supabase
      .from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .update({ estado: 'aprobado', updated_at: nowIso } as never)
      .eq('id', expedienteId)
      .eq('estado', 'condicionado'); // doble check anti-race

    if (updErr) {
      logger.error({ error: updErr.message, expedienteId }, 'Error al aprobar expediente condicionado');
      throw new AppError(500, 'INTERNAL_ERROR', 'Error al aprobar el expediente');
    }

    await (supabase
      .from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
      .insert({
        expediente_id: expedienteId,
        tipo: 'transicion',
        descripcion: 'Propietario aprobó manualmente el expediente condicionado tras revisar la documentación adicional.',
        estado_anterior: 'condicionado',
        estado_nuevo: 'aprobado',
        usuario_id: userId,
        metadata: { manual: true, origen: 'propietario_aprobar_condicionado' },
      } as never);
  }

  // 4. Generar el contrato con los datos enviados.
  let contratoId: string | null = null;
  try {
    const { generarContrato } = await import('@/modules/contratos/contratos.service');
    const result = await generarContrato(
      expedienteId,
      {
        duracion_meses: datosContrato.duracion_contrato_meses,
        fecha_inicio: datosContrato.fecha_inicio_contrato,
      },
      userId,
    );
    contratoId = (result as { id?: string } | null)?.id || null;
    logger.info({ expedienteId, contratoId, fromState }, 'Contrato generado por el propietario');
  } catch (err) {
    logger.error(
      { error: err, expedienteId, fromState },
      'Error al generar contrato — el expediente quedó aprobado, hay que reintentar desde la pestaña Contratos',
    );
  }

  // 5. Notificaciones al solicitante (solo si transicionamos desde
  //    condicionado — en el flujo aprobado-auto el orchestrator ya envió
  //    el email "estudio aprobado" cuando bajó el resultado del buró).
  if (fromState === 'condicionado' && ctx.solicitanteEmail && ctx.solicitanteNombre) {
    sendEstudioAprobadoEmail({
      email: ctx.solicitanteEmail,
      nombre: ctx.solicitanteNombre,
      inmueble: ctx.inmuebleDireccion,
      ciudad: ctx.inmuebleCiudad,
      score: null,
    }).catch((e) => logger.warn({ error: e, expedienteId }, 'Error email aprobado tras condicionado'));

    findPerfilIdByEmail(ctx.solicitanteEmail).then((solicitanteUserId) => {
      if (!solicitanteUserId) return;
      return notificarUsuario({
        userId: solicitanteUserId,
        tipo: 'estudio.aprobado',
        titulo: '¡Tu solicitud fue aprobada!',
        mensaje: 'El propietario revisó tu documentación y aprobó tu solicitud. Estamos preparando el contrato — te avisaremos cuando esté listo para firmar.',
        link: `/expedientes/${expedienteId}`,
        payload: { expediente_id: expedienteId, contrato_id: contratoId, via: 'aprobacion_condicionado' },
      });
    }).catch((e) => logger.warn({ error: e, expedienteId }, 'Error notificando aprobación condicionado'));
  }

  return {
    expediente: { id: ctx.expedienteId, numero: ctx.numero, estado: 'aprobado' },
    contrato_id: contratoId,
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
