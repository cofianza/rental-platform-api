import { supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { logAudit, AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/lib/auditLog';
import type { CreateCommentInput, UpdateCommentInput } from './expediente-comments.schema';

// ============================================================
// Types
// ============================================================

interface CommentRow {
  id: string;
  expediente_id: string;
  usuario_id: string;
  texto: string;
  is_internal: boolean;
  created_at: string;
  updated_at: string;
  usuario: { id: string; nombre: string; apellido: string };
}

const COMMENT_SELECT = `
  id, expediente_id, usuario_id, texto, is_internal, created_at, updated_at,
  usuario:perfiles!comentarios_usuario_id_fkey(id, nombre, apellido)
`;

// ============================================================
// List comments (newest first)
// ============================================================

export async function listComments(expedienteId: string): Promise<CommentRow[]> {
  await verifyExpedienteExists(expedienteId);

  const { data, error } = await (supabase
    .from('comentarios' as string) as ReturnType<typeof supabase.from>)
    .select(COMMENT_SELECT)
    .eq('expediente_id', expedienteId)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ error: error.message, expedienteId }, 'Error al listar comentarios');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al obtener los comentarios');
  }

  return (data as unknown as CommentRow[]) || [];
}

// ============================================================
// Create comment
// ============================================================

export async function createComment(
  expedienteId: string,
  input: CreateCommentInput,
  userId: string,
  ip?: string,
): Promise<CommentRow> {
  await verifyExpedienteExists(expedienteId);

  const { data, error } = await (supabase
    .from('comentarios' as string) as ReturnType<typeof supabase.from>)
    .insert({
      expediente_id: expedienteId,
      usuario_id: userId,
      texto: input.texto,
      is_internal: input.is_internal ?? true,
    } as never)
    .select(COMMENT_SELECT)
    .single();

  if (error) {
    logger.error({ error: error.message, expedienteId }, 'Error al crear comentario');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al crear el comentario');
  }

  const comment = data as unknown as CommentRow;

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.COMMENT_CREATED,
    entidad: AUDIT_ENTITIES.COMENTARIO,
    entidadId: comment.id,
    detalle: { expediente_id: expedienteId },
    ip,
  });

  return comment;
}

// ============================================================
// Update comment (own only)
// ============================================================

export async function updateComment(
  expedienteId: string,
  commentId: string,
  input: UpdateCommentInput,
  userId: string,
  ip?: string,
): Promise<CommentRow> {
  const existing = await getCommentOrFail(commentId, expedienteId);

  if (existing.usuario_id !== userId) {
    throw AppError.forbidden('Solo puedes editar tus propios comentarios');
  }

  const { data, error } = await (supabase
    .from('comentarios' as string) as ReturnType<typeof supabase.from>)
    .update({ texto: input.texto } as never)
    .eq('id', commentId)
    .select(COMMENT_SELECT)
    .single();

  if (error) {
    logger.error({ error: error.message, commentId }, 'Error al actualizar comentario');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al actualizar el comentario');
  }

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.COMMENT_UPDATED,
    entidad: AUDIT_ENTITIES.COMENTARIO,
    entidadId: commentId,
    detalle: { expediente_id: expedienteId, texto_anterior: existing.texto },
    ip,
  });

  return data as unknown as CommentRow;
}

// ============================================================
// Delete comment (admin any, operator own only)
// ============================================================

export async function deleteComment(
  expedienteId: string,
  commentId: string,
  userId: string,
  userRole: string,
  ip?: string,
): Promise<void> {
  const existing = await getCommentOrFail(commentId, expedienteId);

  const isAdmin = userRole === 'administrador';
  if (!isAdmin && existing.usuario_id !== userId) {
    throw AppError.forbidden('Solo puedes eliminar tus propios comentarios');
  }

  const { error } = await (supabase
    .from('comentarios' as string) as ReturnType<typeof supabase.from>)
    .delete()
    .eq('id', commentId);

  if (error) {
    logger.error({ error: error.message, commentId }, 'Error al eliminar comentario');
    throw new AppError(500, 'INTERNAL_ERROR', 'Error al eliminar el comentario');
  }

  logAudit({
    usuarioId: userId,
    accion: AUDIT_ACTIONS.COMMENT_DELETED,
    entidad: AUDIT_ENTITIES.COMENTARIO,
    entidadId: commentId,
    detalle: { expediente_id: expedienteId, texto: existing.texto },
    ip,
  });
}

// ============================================================
// Private helpers
// ============================================================

async function verifyExpedienteExists(id: string): Promise<void> {
  const { data, error } = await (supabase
    .from('expedientes' as string) as ReturnType<typeof supabase.from>)
    .select('id')
    .eq('id', id)
    .single();

  if (error || !data) {
    throw AppError.notFound('Expediente no encontrado');
  }
}

async function getCommentOrFail(commentId: string, expedienteId: string): Promise<CommentRow> {
  const { data, error } = await (supabase
    .from('comentarios' as string) as ReturnType<typeof supabase.from>)
    .select(COMMENT_SELECT)
    .eq('id', commentId)
    .eq('expediente_id', expedienteId)
    .single();

  if (error || !data) {
    throw AppError.notFound('Comentario no encontrado');
  }

  return data as unknown as CommentRow;
}
