import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import {
  getAvailableContratoTransitions,
  getContratoTransitionDef,
  isContratoTransitionValid,
  type EstadoContrato,
  type ContratoPreconditionId,
} from './contrato-state-machine';
import { getContratoById, enviarContratoAFirma, notificarPartesContratoTerminado } from './contratos.service';
import { perfilEsDuenoDeInmueble } from '@/lib/tenantScope';
import type { AuthUser } from '@/types/auth';
import type { ContratoTransitionInput } from './contrato-workflow.schema';

// ============================================================
// Tipos internos
// ============================================================

interface ContratoRow {
  id: string;
  expediente_id: string;
  estado: EstadoContrato;
  storage_key: string | null;
}

interface TransitionRpcResult {
  contrato_id: string;
  estado_anterior: EstadoContrato;
  estado_nuevo: EstadoContrato;
  historial_id: string;
  updated_at: string;
}

// ============================================================
// Ejecutar transicion
// ============================================================

export async function executeContratoTransition(
  contratoId: string,
  input: ContratoTransitionInput,
  user: AuthUser,
) {
  const contrato = await fetchContrato(contratoId);
  const currentState = contrato.estado;
  const targetState = input.nuevo_estado;

  // Validar que la transicion es estructuralmente valida
  if (!isContratoTransitionValid(currentState, targetState)) {
    const validTargets = getAvailableContratoTransitions(currentState);
    throw AppError.badRequest(
      `Transicion invalida: ${currentState} -> ${targetState}`,
      'INVALID_TRANSITION',
      { estado_actual: currentState, transiciones_validas: validTargets },
    );
  }

  // Verificar permisos (incluye ownership para inmobiliaria/propietario)
  await checkTransitionPermissions(user, contrato, targetState);

  // Verificar precondiciones
  const transitionDef = getContratoTransitionDef(currentState, targetState)!;
  await checkPreconditions(transitionDef.preconditions, contrato, input);

  // 4.2 — "Enviar a firma" NO es una transicion pasiva: marcar pendiente_firma
  // sin crear el sobre dejaria el contrato "enviado" sin que ningun firmante
  // reciba nada (el mismo sintoma del bug 4.2, por otro camino). Delegamos en
  // la accion real de envio, que valida los datos de los firmantes, crea el
  // sobre en Auco, registra el historial y REVIERTE el estado si el envio
  // falla. Los checks de permisos/precondiciones de arriba ya corrieron.
  if (targetState === 'pendiente_firma') {
    // Conservar la trazabilidad de la transicion: el comentario (obligatorio
    // en el modal) y el motivo viajan al historial, y se emite el mismo audit
    // CONTRATO_TRANSITIONED que las demas transiciones manuales.
    await enviarContratoAFirma(contratoId, user.id, {
      comentario: input.comentario,
      motivo: input.motivo || null,
      descripcion: buildDescription(currentState, targetState, user, input),
    });
    logAudit({
      usuarioId: user.id,
      accion: AUDIT_ACTIONS.CONTRATO_TRANSITIONED,
      entidad: AUDIT_ENTITIES.CONTRATO,
      entidadId: contratoId,
      detalle: {
        estado_anterior: currentState,
        estado_nuevo: targetState,
        comentario: input.comentario,
        motivo: input.motivo || null,
      },
    });
    const contratoEnviado = await getContratoById(contratoId);
    return { ...(contratoEnviado as Record<string, unknown>), estado_anterior: currentState };
  }

  // Construir descripcion del evento
  const descripcion = buildDescription(currentState, targetState, user, input);

  // Ejecutar transicion atomica via RPC
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc('transicionar_contrato', {
    p_contrato_id: contratoId,
    p_nuevo_estado: targetState,
    p_descripcion: descripcion,
    p_usuario_id: user.id,
    p_comentario: input.comentario,
    p_motivo: input.motivo || null,
  });

  if (error) {
    // Carrera perdedora: el RPC valida from->to bajo FOR UPDATE; si otro
    // actor (usuario concurrente, job de vencimiento, auto-heal) movió el
    // contrato entre nuestro fetch y el RPC, éste lanza 'Transicion no
    // permitida: X -> Y'. Devolver 409 con el estado real (no un 400 genérico)
    // para que el front pueda refrescar y explicar qué pasó.
    const rpcMsg = (error as { message?: string }).message ?? '';
    if (rpcMsg.includes('Transicion no permitida')) {
      const actual = await fetchContrato(contratoId).catch(() => null);
      throw new AppError(
        409,
        'CONTRATO_ESTADO_CAMBIADO',
        'El contrato ya fue actualizado por otro usuario o proceso. Refresca para ver el estado actual.',
        { estado_actual: actual?.estado ?? null },
      );
    }
    logger.error({ error, contratoId }, 'Error al transicionar contrato');
    throw AppError.badRequest('Error al ejecutar la transicion', 'TRANSITION_FAILED');
  }

  const result = data as TransitionRpcResult;

  // Efectos secundarios post-transicion. fromState = el estado_anterior que
  // reporta el RPC (leído bajo FOR UPDATE), NO el currentState leído antes:
  // el auto-heal fire-and-forget puede mover el contrato (pendiente_firma →
  // firmado → vigente) entre nuestro fetch y el RPC, y decidir la liberación
  // del inmueble con un estado obsoleto saltaría la liberación de un vigente.
  await applySideEffects(
    contratoId,
    contrato.expediente_id,
    targetState,
    input,
    result.estado_anterior ?? currentState,
    user.id,
  );

  logger.info(
    { contratoId, from: currentState, to: targetState, userId: user.id },
    'Transicion de contrato ejecutada',
  );

  // Audit log
  logAudit({
    usuarioId: user.id,
    accion: AUDIT_ACTIONS.CONTRATO_TRANSITIONED,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: contratoId,
    detalle: {
      estado_anterior: result.estado_anterior,
      estado_nuevo: result.estado_nuevo,
      comentario: input.comentario,
      motivo: input.motivo || null,
    },
  });

  // Retornar contrato actualizado completo
  const contratoActualizado = await getContratoById(contratoId);

  return {
    ...contratoActualizado,
    estado_anterior: result.estado_anterior,
    historial_id: result.historial_id,
  };
}

// ============================================================
// Transicion automatica del sistema (cron de vencimiento)
// ============================================================

const MOTIVO_VENCIMIENTO = 'Vencimiento automatico: se alcanzo la fecha de fin del contrato.';
const COMENTARIO_VENCIMIENTO = 'Finalizacion automatica por vencimiento del plazo.';

/**
 * Finaliza un contrato VENCIDO como accion del sistema (sin usuario HTTP).
 * Reusa el RPC atomico + efectos secundarios (libera el inmueble) que usa la
 * transicion normal, pero con actor null — mismo patron que post-firma. No
 * aplica checkTransitionPermissions (no hay usuario) ni precondiciones (el motivo se
 * provee aqui). Idempotente: si el contrato ya no esta 'vigente', no hace nada.
 * @returns true si lo finalizo, false si lo omitio.
 */
export async function finalizarContratoVencido(contratoId: string): Promise<boolean> {
  const contrato = await fetchContrato(contratoId);
  // Idempotencia: otra ejecucion/usuario pudo finalizarlo o cancelarlo ya.
  if (contrato.estado !== 'vigente') return false;
  // Defensa en profundidad: la transicion debe seguir siendo valida.
  if (!isContratoTransitionValid('vigente', 'finalizado')) return false;

  const input: ContratoTransitionInput = {
    nuevo_estado: 'finalizado',
    comentario: COMENTARIO_VENCIMIENTO,
    motivo: MOTIVO_VENCIMIENTO,
  };

  // Evaluar las mismas precondiciones que el camino manual (hoy MOTIVO_REQUERIDO,
  // que ya proveemos; a prueba de precondiciones futuras del state-machine).
  const transitionDef = getContratoTransitionDef('vigente', 'finalizado')!;
  await checkPreconditions(transitionDef.preconditions, contrato, input);

  const descripcion = `Estado cambiado de 'vigente' a 'finalizado' por el sistema (vencimiento automatico). Motivo: ${MOTIVO_VENCIMIENTO}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc('transicionar_contrato', {
    p_contrato_id: contratoId,
    p_nuevo_estado: 'finalizado',
    p_descripcion: descripcion,
    p_usuario_id: null, // system action
    p_comentario: input.comentario,
    p_motivo: input.motivo,
  });

  if (error) {
    logger.error({ error, contratoId }, 'Error al finalizar contrato vencido');
    throw AppError.badRequest('Error al finalizar el contrato vencido', 'TRANSITION_FAILED');
  }

  const result = data as TransitionRpcResult;

  // Efectos secundarios: setea fecha_terminacion, libera el inmueble,
  // notifica a las partes y registra el timeline (usuario null = sistema).
  await applySideEffects(contratoId, contrato.expediente_id, 'finalizado', input, 'vigente', null);

  logAudit({
    usuarioId: null,
    accion: AUDIT_ACTIONS.CONTRATO_TRANSITIONED,
    entidad: AUDIT_ENTITIES.CONTRATO,
    entidadId: contratoId,
    detalle: {
      estado_anterior: result.estado_anterior,
      estado_nuevo: result.estado_nuevo,
      motivo: MOTIVO_VENCIMIENTO,
      automatico: true,
    },
  });

  logger.info(
    { contratoId, from: result.estado_anterior, to: result.estado_nuevo },
    'Contrato finalizado automaticamente por vencimiento',
  );
  return true;
}

// ============================================================
// Obtener transiciones disponibles
// ============================================================

export async function getContratoTransitions(contratoId: string, user: AuthUser) {
  const contrato = await fetchContrato(contratoId);
  await assertPuedeVerContrato(user, contrato);

  // Filtrar por ROL con la misma lógica de checkTransitionPermissions: así el
  // GET es la única fuente de verdad y el web nunca ofrece una transición que
  // el POST rechazaría con 403 (inmobiliaria/propietario solo pueden terminar
  // o cancelar; gerencia_consulta es solo-lectura → ninguna).
  let transiciones = getAvailableContratoTransitions(contrato.estado);
  if (user.rol === 'inmobiliaria' || user.rol === 'propietario') {
    transiciones = transiciones.filter((t) => OWNER_TERMINATE_STATES.includes(t.estado));
  } else if (user.rol !== 'administrador' && user.rol !== 'operador_analista') {
    transiciones = [];
  }

  // Moras activas del contrato: la UI advierte antes de terminar (la mora
  // sobrevive a la terminación — el cobro sigue — así que el operador debe
  // decidir si marcarla pagada/cancelarla explícitamente). Best-effort.
  let morasActivas = 0;
  if (transiciones.some((t) => OWNER_TERMINATE_STATES.includes(t.estado))) {
    try {
      const { contarMorasActivasDeContrato } = await import('@/modules/moras/moras.service');
      morasActivas = await contarMorasActivasDeContrato(contratoId);
    } catch {
      // no crítico
    }
  }

  return {
    contrato_id: contratoId,
    estado_actual: contrato.estado,
    transiciones_disponibles: transiciones,
    moras_activas: morasActivas,
  };
}

// ============================================================
// Historial de transiciones
// ============================================================

export async function getContratoTransitionHistory(contratoId: string, user: AuthUser) {
  // Verificar que el contrato existe y que el usuario puede verlo
  const contrato = await fetchContrato(contratoId);
  await assertPuedeVerContrato(user, contrato);

  const { data, error } = await (supabase
    .from('contrato_historial_estados' as string) as ReturnType<typeof supabase.from>)
    .select(`
      id, estado_anterior, estado_nuevo, comentario, motivo, descripcion, created_at,
      usuario:perfiles!contrato_historial_estados_usuario_id_fkey(id, nombre, apellido)
    `)
    .eq('contrato_id', contratoId)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ error: error.message, contratoId }, 'Error al obtener historial de transiciones de contrato');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener el historial de transiciones');
  }

  const rows = (data as unknown as Array<{
    id: string;
    estado_anterior: string | null;
    estado_nuevo: string | null;
    comentario: string | null;
    motivo: string | null;
    descripcion: string;
    created_at: string;
    usuario: { id: string; nombre: string; apellido: string } | null;
  }>) || [];

  return {
    contrato_id: contratoId,
    estado_actual: contrato.estado,
    historial: rows,
  };
}

// ============================================================
// Helpers privados
// ============================================================

async function fetchContrato(id: string): Promise<ContratoRow> {
  const { data, error } = await (supabase
    .from('contratos' as string) as ReturnType<typeof supabase.from>)
    .select('id, expediente_id, estado, storage_key')
    .eq('id', id)
    .single();

  if (error || !data) {
    throw AppError.notFound('Contrato no encontrado');
  }

  return data as unknown as ContratoRow;
}

// Estados terminales que liberan el inmueble. Son los unicos a los que una
// inmobiliaria/propietario puede llevar su propio contrato (terminar/cancelar);
// el resto del workflow lo maneja un rol interno.
const OWNER_TERMINATE_STATES: EstadoContrato[] = ['finalizado', 'cancelado'];

/**
 * Permisos para ejecutar una transicion de contrato.
 * - administrador / operador_analista: cualquier transicion valida.
 * - inmobiliaria / propietario: SOLO terminar o cancelar (estado destino
 *   'finalizado'/'cancelado') y SOLO si administran el inmueble del contrato.
 *   Asi el dueño puede liberar su inmueble para re-arrendar sin depender de un
 *   admin de la plataforma, pero no puede tocar el resto del flujo ni contratos
 *   de terceros.
 */
/**
 * Scoping de LECTURA de los endpoints de workflow (available-transitions e
 * historial). El POST siempre validó ownership, pero los GET no: cualquier
 * inmobiliaria/propietario con el UUID de un contrato ajeno podía leer su
 * estado, transiciones e historial completo (comentarios, motivos, actores) —
 * IDOR cross-tenant (auditoría jul-2026). 404 (no 403) para no confirmar la
 * existencia del contrato. El rol solicitante no tiene vínculo perfil↔
 * solicitantes (solo email) y ninguna vista suya consume estos GET → 404.
 */
async function assertPuedeVerContrato(user: AuthUser, contrato: ContratoRow): Promise<void> {
  if (user.rol === 'administrador' || user.rol === 'operador_analista' || user.rol === 'gerencia_consulta') {
    return;
  }
  if (
    (user.rol === 'inmobiliaria' || user.rol === 'propietario') &&
    (await ownerAdministraContrato(user, contrato))
  ) {
    return;
  }
  throw AppError.notFound('Contrato no encontrado', 'CONTRATO_NOT_FOUND');
}

async function checkTransitionPermissions(
  user: AuthUser,
  contrato: ContratoRow,
  targetState: EstadoContrato,
): Promise<void> {
  if (user.rol === 'administrador' || user.rol === 'operador_analista') return;

  if (user.rol === 'inmobiliaria' || user.rol === 'propietario') {
    if (!OWNER_TERMINATE_STATES.includes(targetState)) {
      throw AppError.forbidden(
        'Solo puedes terminar o cancelar el contrato; el resto del flujo lo gestiona Cofianza.',
        'FORBIDDEN',
      );
    }
    if (!(await ownerAdministraContrato(user, contrato))) {
      throw AppError.forbidden(
        'No puedes modificar un contrato de un inmueble que no administras',
        'FORBIDDEN',
      );
    }
    return;
  }

  throw AppError.forbidden('No tienes permisos para transicionar contratos', 'FORBIDDEN');
}

/** ¿El usuario (inmobiliaria/propietario) administra el inmueble del contrato? */
async function ownerAdministraContrato(user: AuthUser, contrato: ContratoRow): Promise<boolean> {
  const { data: expRow } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('inmueble_id')
    .eq('id', contrato.expediente_id)
    .single();
  const inmuebleId = (expRow as { inmueble_id?: string | null } | null)?.inmueble_id;
  if (!inmuebleId) return false;

  const { data: inmRow } = await (supabase
    .from('inmuebles' as string) as ReturnType<typeof supabase.from>)
    .select('propietario_id, inmobiliaria_id')
    .eq('id', inmuebleId)
    .single();
  const inm = inmRow as { propietario_id?: string | null; inmobiliaria_id?: string | null } | null;
  if (!inm) return false;

  return perfilEsDuenoDeInmueble({
    userId: user.id,
    userRol: user.rol,
    inmueblePropietarioId: inm.propietario_id,
    inmuebleInmobiliariaId: inm.inmobiliaria_id,
  });
}

async function checkPreconditions(
  preconditions: readonly ContratoPreconditionId[],
  contrato: ContratoRow,
  input: ContratoTransitionInput,
): Promise<void> {
  for (const precondition of preconditions) {
    await checkSinglePrecondition(precondition, contrato, input);
  }
}

async function checkSinglePrecondition(
  precondition: ContratoPreconditionId,
  contrato: ContratoRow,
  input: ContratoTransitionInput,
): Promise<void> {
  switch (precondition) {
    case 'PDF_GENERADO': {
      if (!contrato.storage_key) {
        throw AppError.badRequest(
          'El contrato debe tener un PDF generado',
          'PRECONDITION_FAILED',
          { precondition: 'PDF_GENERADO' },
        );
      }
      break;
    }

    case 'ESTUDIO_APROBADO': {
      const { count, error } = await (supabase
        .from('estudios' as string) as ReturnType<typeof supabase.from>)
        .select('id', { count: 'exact', head: true })
        .eq('expediente_id', contrato.expediente_id)
        .eq('resultado', 'aprobado');

      if (error || !count || count === 0) {
        throw AppError.badRequest(
          'Se requiere un estudio con resultado aprobado para enviar a firma',
          'PRECONDITION_FAILED',
          { precondition: 'ESTUDIO_APROBADO' },
        );
      }
      break;
    }

    case 'MOTIVO_REQUERIDO': {
      if (!input.motivo?.trim()) {
        throw AppError.badRequest(
          'Se requiere un motivo para esta transicion',
          'PRECONDITION_FAILED',
          { precondition: 'MOTIVO_REQUERIDO' },
        );
      }
      break;
    }
  }
}

async function applySideEffects(
  contratoId: string,
  expedienteId: string,
  targetState: EstadoContrato,
  input: ContratoTransitionInput,
  fromState: EstadoContrato,
  usuarioId: string | null,
): Promise<void> {
  switch (targetState) {
    case 'firmado': {
      await (supabase
        .from('contratos' as string) as ReturnType<typeof supabase.from>)
        .update({ fecha_firma: new Date().toISOString() } as never)
        .eq('id', contratoId);
      break;
    }

    case 'vigente': {
      // El contrato entra en vigencia: el inmueble queda ARRENDADO. Marcarlo
      // 'ocupado' ANTES de cerrar el expediente (mismo efecto que el auto-heal
      // de firma electrónica; esta ruta cubre la activación manual y el
      // contrato firmado en papel, que antes dejaban el inmueble publicable
      // y aceptando estudios con contrato vigente).
      await ocuparInmuebleDelExpediente(expedienteId);
      await (supabase
        .from('expedientes' as string) as ReturnType<typeof supabase.from>)
        .update({ estado: 'cerrado', updated_at: new Date().toISOString() } as never)
        .eq('id', expedienteId);
      break;
    }

    case 'finalizado': {
      await (supabase
        .from('contratos' as string) as ReturnType<typeof supabase.from>)
        .update({ fecha_terminacion: new Date().toISOString() } as never)
        .eq('id', contratoId);
      // El arriendo terminó: el inmueble vuelve a estar disponible (fuera de vitrina).
      const liberadoFin = await liberarInmuebleDelExpediente(expedienteId, contratoId);
      await aplicarEfectosTerminacion(contratoId, expedienteId, 'finalizado', input, usuarioId, liberadoFin);
      break;
    }

    case 'cancelado': {
      await (supabase
        .from('contratos' as string) as ReturnType<typeof supabase.from>)
        .update({
          motivo_cancelacion: input.motivo || null,
          fecha_terminacion: new Date().toISOString(),
        } as never)
        .eq('id', contratoId);
      // Cancelar desde VIGENTE (arriendo en curso que se rompe): liberación
      // completa (ocupado O en_estudio → disponible).
      // Cancelar PRE-firma: NO tocar el bloqueo temporal 'en_estudio' — ese
      // pertenece al ciclo del EXPEDIENTE (que sigue activo y puede generar
      // otro contrato); su propia cancelación lo libera. PERO sí liberar si el
      // inmueble quedó 'ocupado': cubre cancelar una renovación en
      // pendiente_firma cuando el contrato padre ya finalizó (el guard de
      // renovación evitó liberarlo entonces; sin esto quedaría 'ocupado' para
      // siempre, con el expediente ya cerrado).
      const liberadoCancel = await liberarInmuebleDelExpediente(
        expedienteId,
        contratoId,
        fromState === 'vigente' ? ['ocupado', 'en_estudio'] : ['ocupado'],
      );
      // Si el contrato estaba en firma, cancelar solicitudes + sobres en Auco:
      // sin esto los firmantes conservaban el link activo por WhatsApp y podían
      // firmar (y recibir acuse de) un contrato ya cancelado. Log-only.
      try {
        const { cancelarSolicitudesDeContrato } = await import('@/modules/firma/firma.service');
        await cancelarSolicitudesDeContrato(contratoId);
      } catch (err) {
        logger.error({ err, contratoId }, 'No se pudieron cancelar las solicitudes de firma del contrato cancelado');
      }
      await aplicarEfectosTerminacion(contratoId, expedienteId, 'cancelado', input, usuarioId, liberadoCancel);
      break;
    }
  }
}

/**
 * Efectos comunes de una TERMINACIÓN (finalizado/cancelado), todos log-only:
 *  - Notificación in-app a solicitante y propietario (antes NADIE se enteraba,
 *    ni siquiera con el vencimiento automático).
 *  - Evento en el timeline del expediente (eventos_timeline tipo 'contrato').
 *  - Auto-cancelación de renovaciones PRE-firma (borrador/en_revision/aprobado)
 *    del mismo expediente: al terminar el padre, un borrador de renovación
 *    huérfano seguía operable y podía re-arrendar un inmueble ya liberado y
 *    re-publicado para otro candidato (carrera de doble arriendo). Una
 *    renovación ya en firma o firmada NO se toca: ese es el flujo legítimo que
 *    protege el guard de liberación.
 */
async function aplicarEfectosTerminacion(
  contratoId: string,
  expedienteId: string,
  targetState: 'finalizado' | 'cancelado',
  input: ContratoTransitionInput,
  usuarioId: string | null,
  inmuebleLiberado: boolean,
): Promise<void> {
  const automatico = usuarioId === null;

  notificarPartesContratoTerminado(contratoId, expedienteId, targetState, automatico).catch((e) =>
    logger.warn({ error: e, contratoId }, 'Error notificando terminación del contrato'),
  );

  // MORAS: NO se cancelan — una mora sobrevive al contrato por diseño (el cobro
  // de la fianza continúa tras un impago). Solo dejamos rastro interno para que
  // el asesor revise; la UI ya advierte antes de terminar si hay moras activas.
  import('@/modules/moras/moras.service')
    .then((m) => m.anotarContratoTerminadoEnMoras(contratoId, targetState))
    .catch((e) => logger.warn({ error: e, contratoId }, 'Error anotando moras por terminación'));

  // PAGOS: cancelar links pendientes/en proceso del expediente SOLO si el
  // arriendo terminó de verdad (inmuebleLiberado). Si hay una renovación en
  // curso (guard), los pagos pueden financiarla → NO se tocan. Sin esto, un
  // webhook tardío completaba el pago y facturaba sobre un contrato terminado.
  if (inmuebleLiberado) {
    import('@/modules/pagos/pagos.service')
      .then((p) =>
        p.cancelarPagosPendientesDeExpediente(
          expedienteId,
          `Contrato ${targetState} — pagos pendientes cancelados`,
        ),
      )
      .catch((e) => logger.warn({ error: e, expedienteId }, 'Error cancelando pagos pendientes por terminación'));
  }

  try {
    const descripcion =
      targetState === 'cancelado'
        ? `Contrato cancelado${input.motivo ? `. Motivo: ${input.motivo}` : ''}`
        : automatico
          ? 'Contrato finalizado automáticamente por vencimiento del plazo'
          : `Contrato finalizado${input.motivo ? `. Motivo: ${input.motivo}` : ''}`;
    await (supabase
      .from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
      .insert({
        expediente_id: expedienteId,
        tipo: 'contrato',
        descripcion,
        usuario_id: usuarioId,
        metadata: { contrato_id: contratoId, estado: targetState, automatico },
      } as never);
  } catch (err) {
    logger.warn({ err, contratoId }, 'No se pudo registrar la terminación en el timeline');
  }

  try {
    const { data: hijos } = await (supabase
      .from('contratos' as string) as ReturnType<typeof supabase.from>)
      .select('id, estado')
      .eq('contrato_padre_id', contratoId)
      .in('estado', ['borrador', 'en_revision', 'aprobado']);
    for (const hijo of ((hijos as Array<{ id: string; estado: string }> | null) ?? [])) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: rpcErr } = await (supabase as any).rpc('transicionar_contrato', {
        p_contrato_id: hijo.id,
        p_nuevo_estado: 'cancelado',
        p_descripcion: `Cancelación automática: el contrato padre quedó ${targetState}`,
        p_usuario_id: usuarioId,
        p_comentario: null,
        p_motivo: 'Contrato padre terminado',
      });
      if (rpcErr) {
        logger.warn(
          { contratoId: hijo.id, padre: contratoId, error: (rpcErr as { message?: string }).message },
          'No se pudo auto-cancelar la renovación pre-firma al terminar el padre',
        );
      } else {
        await (supabase
          .from('contratos' as string) as ReturnType<typeof supabase.from>)
          .update({ motivo_cancelacion: 'Contrato padre terminado', fecha_terminacion: new Date().toISOString() } as never)
          .eq('id', hijo.id);
        logger.info({ contratoId: hijo.id, padre: contratoId }, 'Renovación pre-firma auto-cancelada al terminar el padre');
      }
    }
  } catch (err) {
    logger.warn({ err, contratoId }, 'Error auto-cancelando renovaciones pre-firma del contrato terminado');
  }
}

/**
 * ocupado/en_estudio → disponible (fuera de vitrina) al terminar o cancelar el
 * contrato. Se AWAITea en applySideEffects para que el inmueble quede liberado
 * antes de responder (el front re-consulta y lo ve 'disponible'). No re-lanza:
 * si falla, loguea ERROR pero no tumba la transición del contrato (que ya pasó).
 *
 * Guard de RENOVACIÓN: si el mismo expediente tiene OTRO contrato activo o en
 * camino (vigente/firmado/pendiente_firma) — típico al finalizar el contrato
 * padre cuando ya corre su renovación — NO se libera: el inmueble sigue
 * arrendado por el contrato sucesor.
 */
/**
 * @returns `true` si el expediente NO tiene contrato sucesor activo (vigente/
 * firmado/pendiente_firma) — es decir, el arriendo terminó de verdad y el
 * expediente puede tratarse como cerrado (→ seguro cancelar pagos pendientes).
 * `false` si hay una renovación en curso o no se pudo verificar (fail-closed).
 */
async function liberarInmuebleDelExpediente(
  expedienteId: string,
  contratoId: string,
  desde: string[] = ['ocupado', 'en_estudio'],
): Promise<boolean> {
  try {
    const { data: otros, error: guardError } = await (supabase
      .from('contratos' as string) as ReturnType<typeof supabase.from>)
      .select('id')
      .eq('expediente_id', expedienteId)
      .neq('id', contratoId)
      .in('estado', ['vigente', 'firmado', 'pendiente_firma'])
      .limit(1);
    if (guardError) {
      // FAIL-CLOSED: si no podemos confirmar que no hay contrato sucesor, NO
      // liberamos (liberar de más es peor que dejar el inmueble bloqueado).
      logger.error(
        { expedienteId, contratoId, error: guardError.message },
        'Guard de renovación falló — inmueble NO liberado por precaución',
      );
      return false;
    }
    if (((otros as Array<{ id: string }> | null) ?? []).length > 0) {
      logger.info(
        { expedienteId, contratoId },
        'Inmueble NO liberado: el expediente tiene otro contrato activo/en firma (renovación)',
      );
      return false;
    }

    const { data: expRow, error: expError } = await (supabase
      .from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .select('inmueble_id')
      .eq('id', expedienteId)
      .single();
    if (expError) {
      logger.error({ expedienteId, error: expError.message }, 'No se pudo resolver el inmueble del expediente para liberarlo');
      return false;
    }
    const inmuebleId = (expRow as { inmueble_id?: string | null } | null)?.inmueble_id;
    // Sin inmueble no hay nada que liberar, pero el expediente igual quedó sin
    // sucesor → se considera cerrado (safe para cancelar pagos).
    if (!inmuebleId) return true;
    const { liberarInmuebleTrasContrato } = await import('@/modules/inmuebles/inmuebles.service');
    await liberarInmuebleTrasContrato(inmuebleId, desde);
    return true;
  } catch (err) {
    logger.error({ err, expedienteId }, 'No se pudo liberar el inmueble tras fin/cancelación del contrato');
    return false;
  }
}

/**
 * Contrapartida de liberarInmuebleDelExpediente: al quedar VIGENTE el contrato,
 * el inmueble del expediente pasa a 'ocupado' y sale de la vitrina. Mismo
 * patrón log-only: la transición ya se confirmó vía RPC, no se revierte.
 */
async function ocuparInmuebleDelExpediente(expedienteId: string): Promise<void> {
  try {
    const { data: expRow, error: expError } = await (supabase
      .from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .select('inmueble_id')
      .eq('id', expedienteId)
      .single();
    if (expError) {
      logger.error({ expedienteId, error: expError.message }, 'No se pudo resolver el inmueble del expediente para ocuparlo');
      return;
    }
    const inmuebleId = (expRow as { inmueble_id?: string | null } | null)?.inmueble_id;
    if (!inmuebleId) return;
    const { bloquearInmuebleOcupado } = await import('@/modules/inmuebles/inmuebles.service');
    await bloquearInmuebleOcupado(inmuebleId);
  } catch (err) {
    logger.error({ err, expedienteId }, 'No se pudo marcar el inmueble como ocupado al activar el contrato');
  }
}

function buildDescription(
  from: EstadoContrato,
  to: EstadoContrato,
  user: AuthUser,
  input: ContratoTransitionInput,
): string {
  let desc = `Estado cambiado de '${from}' a '${to}' por ${user.email}`;
  if (input.motivo) {
    desc += `. Motivo: ${input.motivo}`;
  }
  if (input.comentario) {
    desc += `. Comentario: ${input.comentario}`;
  }
  return desc;
}
