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
import { getContratoById } from './contratos.service';
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
    logger.error({ error, contratoId }, 'Error al transicionar contrato');
    throw AppError.badRequest('Error al ejecutar la transicion', 'TRANSITION_FAILED');
  }

  const result = data as TransitionRpcResult;

  // Efectos secundarios post-transicion
  await applySideEffects(contratoId, contrato.expediente_id, targetState, input);

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

  // Efectos secundarios: setea fecha_terminacion y libera el inmueble.
  await applySideEffects(contratoId, contrato.expediente_id, 'finalizado', input);

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

export async function getContratoTransitions(contratoId: string) {
  const contrato = await fetchContrato(contratoId);
  const transiciones = getAvailableContratoTransitions(contrato.estado);

  return {
    contrato_id: contratoId,
    estado_actual: contrato.estado,
    transiciones_disponibles: transiciones,
  };
}

// ============================================================
// Historial de transiciones
// ============================================================

export async function getContratoTransitionHistory(contratoId: string) {
  // Verificar que el contrato existe
  const contrato = await fetchContrato(contratoId);

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
      // Marcar expediente como cerrado cuando el contrato entra en vigencia
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
      await liberarInmuebleDelExpediente(expedienteId);
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
      // Contrato cancelado (vigente o pre-firma): liberar el inmueble (fuera de vitrina).
      await liberarInmuebleDelExpediente(expedienteId);
      break;
    }
  }
}

/**
 * ocupado/en_estudio → disponible (fuera de vitrina) al terminar o cancelar el
 * contrato. Se AWAITea en applySideEffects para que el inmueble quede liberado
 * antes de responder (el front re-consulta y lo ve 'disponible'). No re-lanza:
 * si falla, loguea ERROR pero no tumba la transición del contrato (que ya pasó).
 */
async function liberarInmuebleDelExpediente(expedienteId: string): Promise<void> {
  try {
    const { data: expRow } = await (supabase
      .from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .select('inmueble_id')
      .eq('id', expedienteId)
      .single();
    const inmuebleId = (expRow as { inmueble_id?: string | null } | null)?.inmueble_id;
    if (!inmuebleId) return;
    const { liberarInmuebleTrasContrato } = await import('@/modules/inmuebles/inmuebles.service');
    await liberarInmuebleTrasContrato(inmuebleId);
  } catch (err) {
    logger.error({ err, expedienteId }, 'No se pudo liberar el inmueble tras fin/cancelación del contrato');
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
