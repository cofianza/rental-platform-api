import { z } from 'zod';

export const expedienteIdParamsSchema = z.object({
  expedienteId: z.uuid({ error: 'ID de estudio inválido' }),
});

export const pagoIdParamsSchema = z.object({
  pagoId: z.uuid({ error: 'ID de pago inválido' }),
});

export const enviarLinkSchema = z.object({
  email_pagador: z.email({ error: 'Email del arrendatario inválido' }),
  nombre_pagador: z.string().min(1, 'Nombre del arrendatario es requerido').max(200),
  telefono: z.string().max(20).optional(),
});

// Reenvío del link: body opcional para corregir el email/nombre del pagador
// si estaban mal escritos (se persiste en la fila `pagos` y el MISMO link se
// reenvía al corregido — la preference de la pasarela no está atada al email).
export const reenviarLinkSchema = z
  .object({
    email_pagador: z.email({ error: 'Email del arrendatario inválido' }).optional(),
    nombre_pagador: z.string().min(1).max(200).optional(),
  })
  .optional();

// Opcion B: el gestor paga por la pasarela. `reemplazar_pendiente` cancela
// antes el enlace vivo del prospecto.
export const pagarGestorSchema = z
  .object({ reemplazar_pendiente: z.boolean().optional() })
  .optional();

// Reconciliación pública: el payment_id que la pasarela pone en la URL de retorno.
export const reconciliarSchema = z.object({
  payment_id: z.string().min(1, 'payment_id es requerido').max(64),
});

export type ExpedienteIdParams = z.infer<typeof expedienteIdParamsSchema>;
export type PagoIdParams = z.infer<typeof pagoIdParamsSchema>;
export type EnviarLinkInput = z.infer<typeof enviarLinkSchema>;
export type ReenviarLinkInput = z.infer<typeof reenviarLinkSchema>;
export type ReconciliarInput = z.infer<typeof reconciliarSchema>;
export type PagarGestorInput = z.infer<typeof pagarGestorSchema>;
