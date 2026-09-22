import { z } from 'zod';
import { ESTADOS_CONTRATO } from './contrato-state-machine';

export const contratoTransitionBodySchema = z.object({
  nuevo_estado: z.enum(ESTADOS_CONTRATO, {
    error: `Estado inválido. Valores permitidos: ${ESTADOS_CONTRATO.join(', ')}`,
  }),
  comentario: z.string().min(1, { error: 'El comentario es obligatorio' }).max(1000),
  motivo: z.string().max(500).optional(),
  // El estado que el usuario veía: si el contrato cambió mientras tanto (otro miembro lo
  // envió a firma, por ejemplo), 409 en vez de aplicar la acción sobre algo que no vio.
  estado_esperado: z.enum(ESTADOS_CONTRATO).optional(),
});

export type ContratoTransitionInput = z.infer<typeof contratoTransitionBodySchema>;
