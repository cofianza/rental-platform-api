import { z } from 'zod';

export const contratoFirmadoParamsSchema = z.object({
  id: z.string().uuid('ID de contrato invalido'),
});

export const subirFirmadoBodySchema = z.object({
  referencia_otp: z.string().max(200).optional(),
  notas: z.string().max(1000).optional(),
});

export type ContratoFirmadoParams = z.infer<typeof contratoFirmadoParamsSchema>;
export type SubirFirmadoBody = z.infer<typeof subirFirmadoBodySchema>;
