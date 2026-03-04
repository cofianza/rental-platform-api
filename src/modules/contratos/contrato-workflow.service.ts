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

  // Verificar permisos
  checkPermissions(user);

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

function checkPermissions(user: AuthUser): void {
  const canTransition = user.rol === 'administrador' || user.rol === 'operador_analista';

  if (!canTransition) {
    throw AppError.forbidden(
      'Solo un administrador u operador analista puede transicionar contratos',
      'FORBIDDEN',
    );
  }
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
      break;
    }
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
