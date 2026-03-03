import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import { getExpedienteById } from './expedientes.service';

// ============================================================
// Types
// ============================================================

interface AssignmentRpcResult {
  expediente_id: string;
  analista_anterior_id: string | null;
  analista_nuevo_id: string;
  evento_timeline_id: string;
  updated_at: string;
}

interface AssignmentHistoryRow {
  id: string;
  descripcion: string;
  usuario_id: string;
  created_at: string;
  metadata: {
    analista_anterior_id: string | null;
    analista_anterior: string | null;
    analista_nuevo_id: string;
    analista_nuevo: string;
  } | null;
  usuario: { id: string; nombre: string; apellido: string } | null;
}

// ============================================================
// Assign Responsable
// ============================================================

export async function assignResponsable(
  expedienteId: string,
  analistaId: string,
  userId: string,
  userEmail: string,
  ip?: string,
) {
  const descripcion = `Responsable asignado por ${userEmail}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc('asignar_responsable_expediente', {
    p_expediente_id: expedienteId,
    p_nuevo_analista_id: analistaId,
    p_usuario_id: userId,
    p_descripcion: descripcion,
  });

  if (error) {
    logger.error({ error, expedienteId, analistaId }, 'Error al asignar responsable');

    const msg = error.message || '';
    if (msg.includes('no encontrado')) {
      throw AppError.notFound('Expediente no encontrado');
    }
    if (msg.includes('ya es el responsable')) {
      throw AppError.badRequest('El analista seleccionado ya es el responsable actual', 'SAME_ANALYST');
    }
    if (msg.includes('no permitido') || msg.includes('inactivo')) {
      throw AppError.badRequest('Analista no encontrado, inactivo o con rol no permitido', 'INVALID_ANALYST');
    }
    throw AppError.badRequest('Error al asignar responsable', 'ASSIGNMENT_FAILED');
  }

  const result = data as AssignmentRpcResult;

  logger.info(
    { expedienteId, from: result.analista_anterior_id, to: result.analista_nuevo_id, userId },
    'Responsable de expediente asignado',
  );

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.ASSIGNMENT_CREATED,
    entidad: AUDIT_ENTITIES.ASIGNACION,
    entidadId: expedienteId,
    detalle: {
      analista_anterior_id: result.analista_anterior_id,
      analista_nuevo_id: result.analista_nuevo_id,
      evento_timeline_id: result.evento_timeline_id,
    },
    ip,
  });

  return getExpedienteById(expedienteId);
}

// ============================================================
// Assignment History
// ============================================================

export async function getAssignmentHistory(expedienteId: string) {
  // Verify expediente exists
  const { data: expediente, error: expError } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('id', expedienteId)
    .single();

  if (expError || !expediente) {
    throw AppError.notFound('Expediente no encontrado');
  }

  const { data, error } = await (supabase
    .from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
    .select(`
      id, descripcion, usuario_id, created_at, metadata,
      usuario:perfiles!eventos_timeline_usuario_id_fkey(id, nombre, apellido)
    `)
    .eq('expediente_id', expedienteId)
    .eq('tipo', 'asignacion')
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ error: error.message, expedienteId }, 'Error al obtener historial de asignaciones');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener el historial de asignaciones');
  }

  const rows = (data as unknown as AssignmentHistoryRow[]) || [];

  return {
    expediente_id: expedienteId,
    historial: rows.map((row) => ({
      id: row.id,
      descripcion: row.descripcion,
      analista_anterior: row.metadata?.analista_anterior || null,
      analista_anterior_id: row.metadata?.analista_anterior_id || null,
      analista_nuevo: row.metadata?.analista_nuevo || null,
      analista_nuevo_id: row.metadata?.analista_nuevo_id || null,
      usuario: row.usuario || { id: row.usuario_id, nombre: 'Usuario', apellido: '' },
      created_at: row.created_at,
    })),
  };
}
