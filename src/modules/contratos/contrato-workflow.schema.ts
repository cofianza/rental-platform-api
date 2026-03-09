import { z } from 'zod';
import { ESTADOS_CONTRATO } from './contrato-state-machine';

export const contratoTransitionBodySchema = z.object({
  nuevo_estado: z.enum(ESTADOS_CONTRATO, {
    error: `Estado invalido. Valores permitidos: ${ESTADOS_CONTRATO.join(', ')}`,
  }),
  comentario: z.string().min(1, { error: 'El comentario es obligatorio' }).max(1000),
  motivo: z.string().max(500).optional(),
});

export type ContratoTransitionInput = z.infer<typeof contratoTransitionBodySchema>;
