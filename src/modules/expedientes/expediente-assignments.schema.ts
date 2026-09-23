import { z } from 'zod';

export { expedienteIdParamsSchema } from './expediente-workflow.schema';

export const assignBodySchema = z.object({
  analista_id: z.uuid({ error: 'ID de analista inválido' }),
  // «Tomar» desde la bandeja: solo si nadie lo tomó mientras la lista estaba abierta.
  solo_si_libre: z.boolean().optional(),
});

export type AssignBodyInput = z.infer<typeof assignBodySchema>;
