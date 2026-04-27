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

const conceptoFacturable = z.enum(['estudio', 'garantia', 'primer_canon', 'deposito', 'otro']);

export const updateTarifasIvaSchema = z.object({
  tarifas: z
    .array(
      z.object({
        concepto: conceptoFacturable,
        tasa: z.number().min(0, 'No puede ser negativa').max(100, 'Maximo 100'),
      }),
    )
    .min(1, 'Envia al menos una tarifa'),
});

export type FacturaIdParams = z.infer<typeof facturaIdParamsSchema>;
export type PagoIdParams = z.infer<typeof pagoIdParamsSchema>;
export type ListFacturasQuery = z.infer<typeof listFacturasQuerySchema>;
export type UpdateTarifasIvaInput = z.infer<typeof updateTarifasIvaSchema>;
