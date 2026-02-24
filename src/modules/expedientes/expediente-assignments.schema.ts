import { z } from 'zod';

export { expedienteIdParamsSchema } from './expediente-workflow.schema';

export const assignBodySchema = z.object({
  analista_id: z.string().uuid('ID de analista inválido'),
});

export type AssignBodyInput = z.infer<typeof assignBodySchema>;
