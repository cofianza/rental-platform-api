import { z } from 'zod';

export { expedienteIdParamsSchema } from './expediente-workflow.schema';

const TIMELINE_TIPOS = ['transicion', 'comentario', 'asignacion', 'creacion'] as const;

export const timelineQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  tipo: z.enum(TIMELINE_TIPOS).optional(),
});

export type TimelineQuery = z.infer<typeof timelineQuerySchema>;
