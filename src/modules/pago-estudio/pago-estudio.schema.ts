import { z } from 'zod';

export const expedienteIdParamsSchema = z.object({
  expedienteId: z.uuid({ error: 'ID de expediente invalido' }),
});

export const pagoIdParamsSchema = z.object({
  pagoId: z.uuid({ error: 'ID de pago invalido' }),
});

export const enviarLinkSchema = z.object({
  email_pagador: z.email({ error: 'Email del arrendatario invalido' }),
  nombre_pagador: z.string().min(1, 'Nombre del arrendatario es requerido').max(200),
  telefono: z.string().max(20).optional(),
});

export type ExpedienteIdParams = z.infer<typeof expedienteIdParamsSchema>;
export type PagoIdParams = z.infer<typeof pagoIdParamsSchema>;
export type EnviarLinkInput = z.infer<typeof enviarLinkSchema>;
