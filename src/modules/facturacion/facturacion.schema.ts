import { z } from 'zod';

export const facturaIdParamsSchema = z.object({
  id: z.string().uuid('ID de factura invalido'),
});

export const pagoIdParamsSchema = z.object({
  pagoId: z.string().uuid('ID de pago invalido'),
});

export const listFacturasQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  estado: z.enum(['solicitada', 'emitida', 'cancelada']).optional(),
  expediente_id: z.string().uuid().optional(),
});

export type FacturaIdParams = z.infer<typeof facturaIdParamsSchema>;
export type PagoIdParams = z.infer<typeof pagoIdParamsSchema>;
export type ListFacturasQuery = z.infer<typeof listFacturasQuerySchema>;
