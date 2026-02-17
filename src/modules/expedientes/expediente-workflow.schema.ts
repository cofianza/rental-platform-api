import { z } from 'zod';
import { ESTADOS_EXPEDIENTE } from './expediente-state-machine';

export const expedienteIdParamsSchema = z.object({
  id: z.string().uuid('ID de expediente invalido'),
});

export const transitionBodySchema = z.object({
  nuevo_estado: z.enum(ESTADOS_EXPEDIENTE, {
    message: `Estado invalido. Valores permitidos: ${ESTADOS_EXPEDIENTE.join(', ')}`,
  }),
  motivo: z.string().max(500).optional(),
  comentario: z.string().max(1000).optional(),
});

export type TransitionInput = z.infer<typeof transitionBodySchema>;
export type ExpedienteIdParams = z.infer<typeof expedienteIdParamsSchema>;
