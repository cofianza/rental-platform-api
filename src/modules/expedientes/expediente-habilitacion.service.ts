import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { errorNoAdmision } from '../estudios/estudios-simultaneos.guard';
import { env } from '@/config/env';
import {
  sendEstudioHabilitadoEmail,
  sendEstudioNoHabilitadoEmail,
  sendEstudioAprobadoEmail,
} from '../orchestrator/orchestrator.emails';
import { assertHabilitacionPermission } from './expediente-habilitacion.permissions';
import { assertCanonDentroDelTope } from '../estudios/tope-canon.guard';
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
  /**
   * Buró con el que se creará el estudio. Solo los ejecutables por provider;
   * el RPC valida de nuevo y rechaza cualquier otro. Por defecto TransUnion,
   * que era el comportamiento fijo antes de que hubiera dos burós.
   */
  proveedor: 'transunion' | 'datacredito' = 'transunion',
): Promise<HabilitarEstudioResult> {
  // 1. Ownership + datos del expediente para el email posterior.
  const ctx = await assertHabilitacionPermission({
    userId,
    userRol: userRol as UserRole,
    expedienteId,
  });

  // 1.5. TOPE DE CANON — flujo §4.4: "ANTES de avanzar y de generar cualquier
  //      cobro". Va aquí, antes del RPC, porque este es el punto donde el
  //      estudio NACE y donde arranca el cobro: el RPC inserta la fila en
  //      `estudios` y, para el propietario individual, unas líneas más abajo
  //      se auto-crea el link de pago (enviarLinkPago). Bloquear aquí deja el
  //      expediente exactamente como estaba: sin estudio, sin pago, sin
  //      inmueble reservado y sin correo al solicitante.
  await assertCanonDentroDelTope({ expedienteId, origen: 'habilitarEstudio' });

  // 2. RPC atómico: UPDATE expediente + INSERT estudio + INSERT timeline.
  //    Las validaciones (existencia, idempotencia, estado, cita realizada)
  //    viven en el RPC y vienen como mensajes de RAISE EXCEPTION que aquí
  //    se mapean a códigos HTTP específicos.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc('fn_habilitar_estudio_expediente', {
    p_expediente_id: expedienteId,
    p_user_id: userId,
    p_proveedor: proveedor,
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
    // Guard de reserva (Flujo §4.2): la propiedad ya se comprometio con un
    // candidato aprobado, o esta arrendada/inactiva. Es el UNICO bloqueo por
    // inmueble que queda — tener otros estudios en curso no bloquea.
    if (msg.includes('INMUEBLE_RESERVADO')) {
      throw errorNoAdmision({
        admite: false,
        motivo: msg.includes('inactivo') ? 'inactivo' : 'reservado',
        reservadoPorExpedienteId: null,
      });
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

  // Flujo de Gerencia §4.2 (CAMBIO APROBADO): habilitar un estudio ya NO
  // bloquea el inmueble. Aquí vivía un bloqueo fire-and-forget a 'en_estudio'
  // que además nunca funcionó — corría fuera de la transacción de la RPC y
  // solo transicionaba desde 'disponible', así que el segundo candidato pasaba
  // igual. Varios candidatos se evalúan en paralelo y la propiedad se reserva
  // recién cuando uno aprobado avanza a la generación del contrato
  // (fn_reservar_inmueble_para_contrato). El guard que SÍ aplica — no habilitar
  // sobre una propiedad ya reservada — vive ahora dentro de
  // fn_habilitar_estudio_expediente, en la misma transacción.

  // 3. Notificación + pago. La regla de negocio es QUIÉN decide el pago:
  //    - PROPIETARIO individual: se manda directo. Auto-creamos el Checkout
  //      Session y enviarLinkPago() le envía al solicitante el link de pago
  //      (email + WhatsApp); por eso omitimos el email genérico de "habilitado".
  //    - INMOBILIARIA / admin / operador: NO se notifica nada al solicitante
  //      todavía. El gestor decide primero quién paga (usar un crédito, asumir
  //      el costo, o "Enviar link al arrendatario") desde el panel del
  //      expediente. Recién entonces se le escribe al solicitante:
  //        · "Enviar link al arrendatario" → enviarLinkPago() (correo + WhatsApp)
  //        · pagar con crédito             → enviarEnlaceAutorizacion() (Habeas Data)
  //      Mandar aquí el correo "paga el estudio" era prematuro: el solicitante
  //      recibía la orden de pagar aunque la inmobiliaria fuera a cubrirlo con
  //      un crédito.
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
      // Si la pasarela falla, caemos al email genérico para que el solicitante
      // al menos sepa que el estudio fue habilitado y pueda intentar desde
      // el panel (futuro: self-service).
      logger.warn(
        { error: pagoError, expedienteId, estudioId: rpcResult.estudio_id },
        'Error al auto-crear pago de estudio post-habilitación',
      );
      await sendHabilitadoFallbackEmail(expedienteId, rpcResult.numero, ctx);
    }
  } else {
    // Inmobiliaria / admin / operador (o expediente sin solicitante vinculado):
    // la decisión de pago es manual, así que NO se envía correo ni notificación
    // al solicitante hasta que el gestor elija una opción de pago. Ver comentario.
    logger.info(
      { expedienteId, userRol, source: ctx.source },
      'Estudio habilitado por gestor (no propietario) — notificación al solicitante diferida a la decisión de pago',
    );
  }

  // Notificacion in-app al solicitante — SOLO en el flujo directo del propietario
  // (puedeAutoCrearPago). Para inmobiliaria/admin/operador se omite: aún no hay
  // nada que el solicitante deba hacer hasta que el gestor decida el pago, así que
  // tampoco le escribimos en la campana. Fire-and-forget.
  if (puedeAutoCrearPago && ctx.solicitanteEmail) {
    findPerfilIdByEmail(ctx.solicitanteEmail).then((solicitanteUserId) => {
      if (!solicitanteUserId) return;
      return notificarUsuario({
        userId: solicitanteUserId,
        tipo: 'estudio.habilitado',
        titulo: 'Estudio habilitado',
        mensaje: 'El propietario habilitó tu estudio crediticio. Realiza el pago para continuar con la evaluación.',
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
        titulo: 'Solicitud no continúa',
        mensaje: motivoNorm
          ? `Tras la visita a ${ctx.inmuebleDireccion}, el propietario decidió no habilitar el estudio. Motivo: ${motivoNorm}`
          : `Tras la visita a ${ctx.inmuebleDireccion}, el propietario decidió no habilitar el estudio.`,
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
 * Tarea 3.2: marcar que la cita se omite porque ya hubo contacto/visita por
 * fuera (p. ej. coordinada por WhatsApp tras "Me interesa"). Esto habilita
 * poder correr el estudio sin exigir una cita 'realizada' (el gate de la RPC
 * fn_habilitar_estudio_expediente salta cuando cita_omitida=true).
 *
 * Ownership: mismo guard que habilitar (propietario/inmobiliaria dueños +
 * admin/operador). Idempotente: si ya estaba omitida, devuelve el estado actual.
 */
export async function omitirCita(
  expedienteId: string,
  motivo: string | undefined,
  userId: string,
  userRol: string,
): Promise<{ expediente: { id: string; numero: string; cita_omitida: true } }> {
  await assertHabilitacionPermission({
    userId,
    userRol: userRol as UserRole,
    expedienteId,
  });

  const { data: current } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id, numero, estudio_habilitado, cita_omitida')
    .eq('id', expedienteId)
    .single() as {
      data: { id: string; numero: string; estudio_habilitado: boolean; cita_omitida: boolean } | null;
    };

  if (!current) throw AppError.notFound('Expediente no encontrado');
  if (current.estudio_habilitado) {
    throw AppError.conflict(
      'El estudio ya fue habilitado; no aplica omitir la cita.',
      'ESTUDIO_YA_HABILITADO',
    );
  }
  if (current.cita_omitida) {
    return { expediente: { id: current.id, numero: current.numero, cita_omitida: true } };
  }

  const motivoNorm = motivo?.trim() ? motivo.trim() : null;
  const { error: updErr } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .update({ cita_omitida: true, updated_at: new Date().toISOString() } as never)
    .eq('id', expedienteId);

  if (updErr) {
    logger.error({ error: updErr.message, expedienteId }, 'Error al omitir la cita');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al omitir la cita');
  }

  await (supabase
    .from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: expedienteId,
      tipo: 'cita',
      descripcion: motivoNorm
        ? `Cita omitida (contacto/visita previa por fuera). Motivo: ${motivoNorm}`
        : 'Cita omitida: el gestor indicó que la visita ya se coordinó por fuera.',
      usuario_id: userId,
      metadata: { cita_omitida: true, motivo: motivoNorm },
    } as never);

  logger.info({ expedienteId, userId, motivo: motivoNorm }, 'Cita omitida por contacto previo');
  return { expediente: { id: current.id, numero: current.numero, cita_omitida: true } };
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
  datosContrato?: { duracion_contrato_meses: number; fecha_inicio_contrato: string },
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
  datosContrato?: { duracion_contrato_meses: number; fecha_inicio_contrato: string };
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
  //    re-generación), solo si vinieron. Aún no transicionamos estado.
  if (datosContrato) {
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
  }

  // 3. Transición condicionado → aprobado (solo si venía de condicionado).
  if (fromState === 'condicionado') {
    const { data: updRows, error: updErr } = await (supabase
      .from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .update({ estado: 'aprobado', updated_at: nowIso } as never)
      .eq('id', expedienteId)
      .eq('estado', 'condicionado') // doble check anti-race
      .select('id');

    if (updErr) {
      logger.error({ error: updErr.message, expedienteId }, 'Error al aprobar expediente condicionado');
      throw new AppError(500, 'INTERNAL_ERROR', 'Error al aprobar el expediente');
    }

    // 0 filas = otro proceso cambió el estado entre la lectura del contexto y
    // este UPDATE. El caso real es la ponderación del coarrendatario: su
    // estudio completa mientras el gestor tiene la card abierta y el
    // expediente pasa a aprobado/rechazado solo. Sin este check, la función
    // respondía 'aprobado', insertaba un evento de timeline falso y disparaba
    // notificaciones de aprobación sobre un expediente que pudo quedar
    // RECHAZADO por la ponderación.
    if (!updRows || updRows.length === 0) {
      throw AppError.conflict(
        'El expediente cambió de estado mientras decidías (p. ej. completó el estudio del co-arrendatario). Refresca para ver el estado actual.',
        'EXPEDIENTE_ESTADO_CAMBIADO',
      );
    }

    await (supabase
      .from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
      .insert({
        expediente_id: expedienteId,
        tipo: 'estado',
        descripcion: 'Propietario aprobó manualmente el expediente condicionado tras revisar la documentación adicional.',
        estado_anterior: 'condicionado',
        estado_nuevo: 'aprobado',
        usuario_id: userId,
        metadata: { manual: true, origen: 'propietario_aprobar_condicionado' },
      } as never);
  }

  // 4. Generar el contrato SOLO si vinieron los datos. Si no, el expediente
  //    queda 'aprobado' sin contrato y este se genera luego desde la pestaña
  //    Contratos con el formulario completo (modalidad de fianza + servicios).
  let contratoId: string | null = null;
  if (datosContrato) {
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
      // La RESERVA de la propiedad (Flujo §4.2) es la excepción que SÍ sube.
      // Si otro candidato aprobado se llevó el inmueble, tragarse el error
      // dejaría al gestor con un "aprobado" mudo y sin contrato, sin saber por
      // qué — y volviendo a pulsar el botón para siempre. El expediente queda
      // aprobado (correcto: el candidato sigue siendo apto) y el mensaje le
      // dice que puede usarlo para otra propiedad.
      if (
        err instanceof AppError &&
        (err.errorCode === 'INMUEBLE_YA_RESERVADO' || err.errorCode === 'RESERVA_NO_VERIFICABLE')
      ) {
        logger.warn(
          { expedienteId, fromState, errorCode: err.errorCode },
          'Generación de contrato abortada: la propiedad ya estaba reservada por otro candidato',
        );
        throw err;
      }
      logger.error(
        { error: err, expedienteId, fromState },
        'Error al generar contrato — el expediente quedó aprobado, hay que reintentar desde la pestaña Contratos',
      );
    }
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
        titulo: 'Solicitud aprobada',
        mensaje: 'El propietario revisó tu documentación y aprobó tu solicitud. Te avisaremos cuando el contrato esté listo para firmar.',
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
