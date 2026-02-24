import { z } from 'zod';

// Re-use expediente ID params
export { expedienteIdParamsSchema } from './expediente-workflow.schema';

// Params: expedienteId + commentId
export const commentParamsSchema = z.object({
  id: z.uuid({ error: 'ID de expediente invalido' }),
  commentId: z.uuid({ error: 'ID de comentario invalido' }),
});

// Body: create comment
export const createCommentSchema = z.object({
  texto: z
    .string()
    .min(1, { error: 'El comentario no puede estar vacio' })
    .max(5000, 'El comentario no debe exceder 5000 caracteres'),
  is_internal: z.boolean().default(true).optional(),
});

// Body: update comment
export const updateCommentSchema = z.object({
  texto: z
    .string()
    .min(1, { error: 'El comentario no puede estar vacio' })
    .max(5000, 'El comentario no debe exceder 5000 caracteres'),
});

export type CommentParams = z.infer<typeof commentParamsSchema>;
export type CreateCommentInput = z.infer<typeof createCommentSchema>;
export type UpdateCommentInput = z.infer<typeof updateCommentSchema>;
