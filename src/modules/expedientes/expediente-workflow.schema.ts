import { z } from 'zod';
import { ESTADOS_EXPEDIENTE } from './expediente-state-machine';

export const expedienteIdParamsSchema = z.object({
  id: z.uuid({ error: 'ID de expediente invalido' }),
});

export const transitionBodySchema = z.object({
  nuevo_estado: z.enum(ESTADOS_EXPEDIENTE, {
    error: `Estado invalido. Valores permitidos: ${ESTADOS_EXPEDIENTE.join(', ')}`,
  }),
  comentario: z.string().min(1, { error: 'El comentario es obligatorio' }).max(1000),
  motivo: z.string().max(500).optional(),
});

export type TransitionInput = z.infer<typeof transitionBodySchema>;
export type ExpedienteIdParams = z.infer<typeof expedienteIdParamsSchema>;
