import { z } from 'zod';

export { expedienteIdParamsSchema } from './expediente-workflow.schema';

export const assignBodySchema = z.object({
  analista_id: z.uuid({ error: 'ID de analista inválido' }),
});

export type AssignBodyInput = z.infer<typeof assignBodySchema>;
