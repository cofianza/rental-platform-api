import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import {
  getAvailableTransitions,
  getTransitionDef,
  isTransitionValid,
  type EstadoExpediente,
  type PreconditionId,
} from './expediente-state-machine';
import { getExpedienteById } from './expedientes.service';
import { perfilEsDuenoDeInmueble } from '@/lib/tenantScope';
import type { AuthUser } from '@/types/auth';
import type { TransitionInput } from './expediente-workflow.schema';

// ============================================================
// Tipos internos
// ============================================================

interface ExpedienteRow {
  id: string;
  numero: string;
  estado: EstadoExpediente;
  analista_id: string | null;
  /** Propietario del inmueble — necesario para validar ownership cuando el
   *  caller es propietario/inmobiliaria. */
  propietario_id: string | null;
  /** Organización dueña del inmueble (multi-tenant ownership org-aware). */
  inmobiliaria_id: string | null;
}

// Transiciones que el propietario / inmobiliaria pueden ejecutar sobre los
// expedientes de SUS propios inmuebles. El dueño puede CERRAR / CANCELAR
// el expediente en cualquier estado dando un motivo — no necesita pedir
// permiso a un admin para abandonar un flujo. Las transiciones intermedias
// (aprobar, rechazar, condicionar) siguen siendo del analista.
const PROPIETARIO_TRANSITIONS: ReadonlyArray<{ from: EstadoExpediente; to: EstadoExpediente }> = [
  { from: 'borrador', to: 'cerrado' },
  { from: 'en_revision', to: 'cerrado' },
  { from: 'informacion_incompleta', to: 'cerrado' },
  { from: 'condicionado', to: 'cerrado' },
  { from: 'aprobado', to: 'cerrado' },
  { from: 'rechazado', to: 'cerrado' },
];

interface TransitionRpcResult {
  expediente_id: string;
  estado_anterior: EstadoExpediente;
  estado_nuevo: EstadoExpediente;
  evento_timeline_id: string;
  updated_at: string;
}

// ============================================================
// Ejecutar transicion
// ============================================================

export async function executeTransition(
  expedienteId: string,
  input: TransitionInput,
  user: AuthUser,
) {
  const expediente = await fetchExpediente(expedienteId);
  const currentState = expediente.estado;
  const targetState = input.nuevo_estado;

  // Validar que la transicion es estructuralmente valida
  if (!isTransitionValid(currentState, targetState)) {
    const validTargets = getAvailableTransitions(currentState);
    throw AppError.badRequest(
      `Transicion invalida: ${currentState} -> ${targetState}`,
      'INVALID_TRANSITION',
      { estado_actual: currentState, transiciones_validas: validTargets },
    );
  }

  // Verificar permisos (incluye ownership para propietario/inmobiliaria
  // y filtra qué transiciones puede hacer cada rol).
  await checkPermissions(expediente, user, currentState, targetState);

  // Verificar precondiciones
  const transitionDef = getTransitionDef(currentState, targetState)!;
  await checkPreconditions(transitionDef.preconditions, expediente, input);

  // Construir descripcion del evento
  const descripcion = buildTimelineDescription(currentState, targetState, user, input);

  // Ejecutar transicion atomica via RPC
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc('transicionar_expediente', {
    p_expediente_id: expedienteId,
    p_nuevo_estado: targetState,
    p_descripcion: descripcion,
    p_usuario_id: user.id,
    p_comentario: input.comentario,
  });

  if (error) {
    logger.error({ error, expedienteId }, 'Error al transicionar expediente');
    throw AppError.badRequest('Error al ejecutar la transicion', 'TRANSITION_FAILED');
  }

  const result = data as TransitionRpcResult;

  // Si la transicion fue "Cancelar expediente" (cualquier estado activo →
  // cerrado con esa etiqueta), persistimos las columnas de cancelacion para
  // que el UI distinga entre cierre natural y abandono mid-flow. Si la
  // etiqueta no llega (clientes viejos o el caller no la mando), inferimos
  // por estado_anterior: aprobado/borrador/en_revision/info_incompleta/
  // condicionado → cerrado siempre fue cancelacion (rechazado→cerrado es la
  // unica transicion al cerrado que no es abandono).
  const ESTADOS_CANCELABLES: EstadoExpediente[] = [
    'borrador',
    'en_revision',
    'informacion_incompleta',
    'condicionado',
    'aprobado',
  ];
  const fueCancelacion =
    targetState === 'cerrado' &&
    (input.etiqueta === 'Cancelar expediente' ||
      (ESTADOS_CANCELABLES.includes(currentState) && !!input.comentario));

  if (fueCancelacion) {
    const { error: updErr } = await (supabase
      .from('expedientes' as string) as ReturnType<typeof supabase.from>)
      .update({
        cancelado_at: new Date().toISOString(),
        motivo_cancelacion: input.comentario,
        estado_pre_cancelacion: currentState,
      } as never)
      .eq('id', expedienteId);
    if (updErr) {
      // No abortamos — la transicion ya quedo. Solo dejamos rastro: el
      // expediente quedara como cerrado-sin-marcar-cancelacion y la UI
      // lo mostrara como "finalizado" (mismo bug que veniamos solucionando)
      // pero al menos el cierre quedo bien.
      logger.warn(
        { expedienteId, err: updErr.message },
        'No se pudo persistir info de cancelacion — el expediente quedo cerrado pero sin marca de cancelacion',
      );
    }

  }

  // Liberar el inmueble si estaba bloqueado temporalmente (en_estudio) por
  // este expediente. Corre en TODO rechazo o cierre — no solo en cancelación:
  // antes un condicionado→rechazado manual dejaba el inmueble atascado en
  // 'en_estudio' para siempre (sin admitir nuevos estudios ni volver a
  // vitrina). Es seguro para el cierre natural post-contrato: el flujo del
  // contrato ya marcó el inmueble 'ocupado' y liberarInmuebleEnEstudio solo
  // transiciona desde 'en_estudio'. Fire-and-forget.
  if (targetState === 'rechazado' || targetState === 'cerrado') {
    (async () => {
      const { data: expRow } = await (supabase
        .from('expedientes' as string) as ReturnType<typeof supabase.from>)
        .select('inmueble_id')
        .eq('id', expedienteId)
        .maybeSingle();
      const inmuebleId = (expRow as { inmueble_id?: string | null } | null)?.inmueble_id;
      if (inmuebleId) {
        const { liberarInmuebleEnEstudio } = await import('../inmuebles/inmuebles.service');
        await liberarInmuebleEnEstudio(inmuebleId);
      }
    })().catch((e) => logger.warn({ e, expedienteId }, 'No se pudo liberar el inmueble tras rechazo/cierre'));
  }

  logger.info(
    { expedienteId, from: currentState, to: targetState, userId: user.id, cancelacion: fueCancelacion },
    'Transicion de expediente ejecutada',
  );

  // Retornar expediente actualizado completo con relaciones
  const expedienteActualizado = await getExpedienteById(expedienteId);

  return {
    ...expedienteActualizado,
    estado_anterior: result.estado_anterior,
    evento_timeline_id: result.evento_timeline_id,
  };
}

// ============================================================
// Obtener transiciones disponibles
// ============================================================

export async function getTransitionsForExpediente(expedienteId: string) {
  const expediente = await fetchExpediente(expedienteId);
  const transiciones = getAvailableTransitions(expediente.estado);

  return {
    expediente_id: expedienteId,
    estado_actual: expediente.estado,
    transiciones_disponibles: transiciones,
  };
}

// ============================================================
// Historial de transiciones
// ============================================================

export async function getTransitionHistory(expedienteId: string) {
  // Verificar que el expediente existe
  const expediente = await fetchExpediente(expedienteId);

  const { data, error } = await (supabase
    .from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
    .select(`
      id, estado_anterior, estado_nuevo, comentario, descripcion, created_at,
      usuario:perfiles!eventos_timeline_usuario_id_fkey(id, nombre, apellido)
    `)
    .eq('expediente_id', expedienteId)
    .eq('tipo', 'estado')
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ error: error.message, expedienteId }, 'Error al obtener historial de transiciones');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener el historial de transiciones');
  }

  const rows = (data as unknown as Array<{
    id: string;
    estado_anterior: string | null;
    estado_nuevo: string | null;
    comentario: string | null;
    descripcion: string;
    created_at: string;
    usuario: { id: string; nombre: string; apellido: string } | null;
  }>) || [];

  return {
    expediente_id: expedienteId,
    estado_actual: expediente.estado,
    historial: rows,
  };
}

// ============================================================
// Helpers privados
// ============================================================

async function fetchExpediente(id: string): Promise<ExpedienteRow> {
  const { data, error } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id, numero, estado, analista_id, inmuebles(propietario_id, inmobiliaria_id)')
    .eq('id', id)
    .single();

  if (error || !data) {
    throw AppError.notFound('Expediente no encontrado');
  }

  const row = data as unknown as {
    id: string;
    numero: string;
    estado: EstadoExpediente;
    analista_id: string | null;
    inmuebles: { propietario_id: string; inmobiliaria_id: string | null } | null;
  };

  return {
    id: row.id,
    numero: row.numero,
    estado: row.estado,
    analista_id: row.analista_id,
    propietario_id: row.inmuebles?.propietario_id ?? null,
    inmobiliaria_id: row.inmuebles?.inmobiliaria_id ?? null,
  };
}

async function checkPermissions(
  expediente: ExpedienteRow,
  user: AuthUser,
  fromState: EstadoExpediente,
  toState: EstadoExpediente,
): Promise<void> {
  const isAdmin = user.rol === 'administrador' || user.rol === 'operador_analista';
  const isAssignedAnalyst = expediente.analista_id === user.id;

  if (isAdmin || isAssignedAnalyst) return;

  // Propietario / inmobiliaria pueden cerrar SUS expedientes terminales.
  // No tienen permiso para hacer transiciones intermedias (las del analista).
  const isPropietarioRol = user.rol === 'propietario' || user.rol === 'inmobiliaria';
  if (isPropietarioRol) {
    // Org-aware: dueño directo o miembro de la organización dueña del inmueble.
    const esDueno = await perfilEsDuenoDeInmueble({
      userId: user.id,
      userRol: user.rol,
      inmueblePropietarioId: expediente.propietario_id,
      inmuebleInmobiliariaId: expediente.inmobiliaria_id,
    });
    if (!esDueno) {
      throw AppError.forbidden(
        'Solo el dueño del inmueble puede cambiar el estado de este expediente',
        'EXPEDIENTE_FORBIDDEN',
      );
    }
    const allowed = PROPIETARIO_TRANSITIONS.some(
      (t) => t.from === fromState && t.to === toState,
    );
    if (!allowed) {
      throw AppError.forbidden(
        `Como ${user.rol} solo puedes cerrar expedientes ya aprobados o rechazados. La transicion ${fromState} → ${toState} requiere un administrador.`,
        'TRANSITION_NOT_ALLOWED_FOR_ROLE',
      );
    }
    return;
  }

  throw AppError.forbidden(
    'Solo el analista asignado, un administrador o el dueño del inmueble pueden transicionar este expediente',
    'FORBIDDEN',
  );
}

async function checkPreconditions(
  preconditions: readonly PreconditionId[],
  expediente: ExpedienteRow,
  input: TransitionInput,
): Promise<void> {
  for (const precondition of preconditions) {
    await checkSinglePrecondition(precondition, expediente, input);
  }
}

async function checkSinglePrecondition(
  precondition: PreconditionId,
  expediente: ExpedienteRow,
  input: TransitionInput,
): Promise<void> {
  switch (precondition) {
    case 'ANALISTA_ASIGNADO': {
      if (!expediente.analista_id) {
        throw AppError.badRequest(
          'El expediente debe tener un analista asignado',
          'PRECONDITION_FAILED',
          { precondition: 'ANALISTA_ASIGNADO' },
        );
      }
      break;
    }

    case 'DOCUMENTOS_EXISTENTES': {
      const { count, error } = await (supabase
        .from('documentos' as string) as ReturnType<typeof supabase.from>)
        .select('id', { count: 'exact', head: true })
        .eq('expediente_id', expediente.id);

      if (error || !count || count === 0) {
        throw AppError.badRequest(
          'El expediente debe tener al menos un documento',
          'PRECONDITION_FAILED',
          { precondition: 'DOCUMENTOS_EXISTENTES' },
        );
      }
      break;
    }

    case 'ESTUDIO_APROBADO': {
      const { count, error } = await (supabase
        .from('estudios' as string) as ReturnType<typeof supabase.from>)
        .select('id', { count: 'exact', head: true })
        .eq('expediente_id', expediente.id)
        .eq('resultado', 'aprobado');

      if (error || !count || count === 0) {
        throw AppError.badRequest(
          'Se requiere un estudio con resultado aprobado',
          'PRECONDITION_FAILED',
          { precondition: 'ESTUDIO_APROBADO' },
        );
      }
      break;
    }

    case 'ESTUDIO_RECHAZADO': {
      const { count, error } = await (supabase
        .from('estudios' as string) as ReturnType<typeof supabase.from>)
        .select('id', { count: 'exact', head: true })
        .eq('expediente_id', expediente.id)
        .eq('resultado', 'rechazado');

      if (error || !count || count === 0) {
        throw AppError.badRequest(
          'Se requiere un estudio con resultado rechazado',
          'PRECONDITION_FAILED',
          { precondition: 'ESTUDIO_RECHAZADO' },
        );
      }
      break;
    }

    case 'ESTUDIO_CONDICIONADO': {
      const { count, error } = await (supabase
        .from('estudios' as string) as ReturnType<typeof supabase.from>)
        .select('id', { count: 'exact', head: true })
        .eq('expediente_id', expediente.id)
        .eq('resultado', 'condicionado');

      if (error || !count || count === 0) {
        throw AppError.badRequest(
          'Se requiere un estudio con resultado condicionado',
          'PRECONDITION_FAILED',
          { precondition: 'ESTUDIO_CONDICIONADO' },
        );
      }
      break;
    }

    case 'DOCUMENTOS_NUEVOS_DESDE_ULTIMA_TRANSICION': {
      const { data: lastEvent } = await (supabase
        .from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
        .select('created_at')
        .eq('expediente_id', expediente.id)
        .eq('tipo', 'estado')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (lastEvent) {
        const evt = lastEvent as unknown as { created_at: string };
        const { count, error } = await (supabase
          .from('documentos' as string) as ReturnType<typeof supabase.from>)
          .select('id', { count: 'exact', head: true })
          .eq('expediente_id', expediente.id)
          .gt('created_at', evt.created_at);

        if (error || !count || count === 0) {
          throw AppError.badRequest(
            'Se requieren documentos nuevos desde la ultima revision',
            'PRECONDITION_FAILED',
            { precondition: 'DOCUMENTOS_NUEVOS_DESDE_ULTIMA_TRANSICION' },
          );
        }
      }
      break;
    }

    case 'CONTRATO_FIRMADO_O_MOTIVO': {
      // Aceptamos motivo o comentario indistintamente — el modal del frontend
      // tiene un solo campo "Comentario / Motivo" y lo manda como `comentario`.
      if (input.motivo?.trim() || input.comentario?.trim()) {
        break;
      }

      const { count, error } = await (supabase
        .from('contratos' as string) as ReturnType<typeof supabase.from>)
        .select('id', { count: 'exact', head: true })
        .eq('expediente_id', expediente.id)
        .eq('estado', 'firmado');

      if (error || !count || count === 0) {
        throw AppError.badRequest(
          'Se requiere un contrato firmado o un motivo/comentario de cierre',
          'PRECONDITION_FAILED',
          { precondition: 'CONTRATO_FIRMADO_O_MOTIVO' },
        );
      }
      break;
    }

    case 'MOTIVO_CIERRE': {
      // Para cancelaciones desde estados activos: motivo o comentario obligatorio.
      // El modal manda `comentario` (campo único "Comentario / Motivo"), pero
      // aceptamos cualquiera para no acoplar la regla al naming del UI.
      if (!input.motivo?.trim() && !input.comentario?.trim()) {
        throw AppError.badRequest(
          'Se requiere un motivo/comentario para cerrar el expediente',
          'PRECONDITION_FAILED',
          { precondition: 'MOTIVO_CIERRE' },
        );
      }
      break;
    }
  }
}

function buildTimelineDescription(
  from: EstadoExpediente,
  to: EstadoExpediente,
  user: AuthUser,
  input: TransitionInput,
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
