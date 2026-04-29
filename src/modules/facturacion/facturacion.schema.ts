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

// Override opcional al facturar un pago: si vienen estos campos, se
// validan estricto (CLIENTE_DATOS_INCOMPLETOS si falta alguno) y se
// usan en lugar de los del solicitante.
export const facturarPagoSchema = z.object({
  numero_documento: z.string().min(1).max(20).optional(),
  tipo_documento: z.string().min(1).max(20).optional(),
  nombre_completo: z.string().min(1).max(200).optional(),
  direccion: z.string().min(1).max(200).optional(),
  email: z.string().email('Email invalido').max(200).optional(),
  telefono: z.string().min(1).max(20).optional(),
  municipio_codigo: z.string().regex(/^\d{5}$/, 'Codigo DANE invalido (5 digitos)').optional(),
});

export type FacturaIdParams = z.infer<typeof facturaIdParamsSchema>;
export type PagoIdParams = z.infer<typeof pagoIdParamsSchema>;
export type ListFacturasQuery = z.infer<typeof listFacturasQuerySchema>;
export type UpdateTarifasIvaInput = z.infer<typeof updateTarifasIvaSchema>;
export type FacturarPagoInput = z.infer<typeof facturarPagoSchema>;
