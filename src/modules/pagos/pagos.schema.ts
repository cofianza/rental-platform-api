import { z } from 'zod';

// ============================================================
// Enums
// ============================================================

export const CONCEPTOS_PAGO = ['estudio', 'garantia', 'primer_canon', 'deposito', 'otro'] as const;
export const METODOS_PAGO = ['pasarela', 'transferencia', 'efectivo', 'cheque'] as const;
export const ESTADOS_PAGO = ['pendiente', 'procesando', 'completado', 'fallido', 'reembolsado', 'cancelado'] as const;

// ============================================================
// Params
// ============================================================

export const pagoIdParamsSchema = z.object({
  id: z.uuid({ error: 'ID de pago invalido' }),
});

export const expedienteIdParamsSchema = z.object({
  expedienteId: z.uuid({ error: 'ID de expediente invalido' }),
});

// ============================================================
// Create payment link (via gateway)
// ============================================================

export const createPaymentLinkSchema = z.object({
  expediente_id: z.uuid({ error: 'ID de expediente invalido' }),
  concepto: z.enum(CONCEPTOS_PAGO, { error: 'Concepto invalido' }),
  monto: z.number().int().positive('Monto debe ser un entero positivo en COP'),
  descripcion: z.string().max(500).optional(),
  success_url: z.url({ error: 'URL de exito invalida' }),
  cancel_url: z.url({ error: 'URL de cancelacion invalida' }),
});

// ============================================================
// Register manual payment
// ============================================================

export const registerManualPaymentSchema = z.object({
  expediente_id: z.uuid({ error: 'ID de expediente invalido' }),
  concepto: z.enum(CONCEPTOS_PAGO, { error: 'Concepto invalido' }),
  monto: z.number().int().positive('Monto debe ser un entero positivo en COP'),
  metodo: z.enum(['transferencia', 'efectivo', 'cheque'] as const, { error: 'Metodo de pago invalido' }),
  descripcion: z.string().max(500).optional(),
  comprobante_url: z.string().max(1000).optional(),
  notas: z.string().max(2000).optional(),
  fecha_pago: z.coerce.date().optional(),
});

// ============================================================
// List query
// ============================================================

export const listPagosQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  expediente_id: z.uuid().optional(),
  concepto: z.string().optional(),
  estado: z.string().optional(),
  sortBy: z.enum(['created_at', 'monto', 'fecha_pago']).default('created_at'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

// ============================================================
// Type exports
// ============================================================

export type PagoIdParams = z.infer<typeof pagoIdParamsSchema>;
export type CreatePaymentLinkInput = z.infer<typeof createPaymentLinkSchema>;
export type RegisterManualPaymentInput = z.infer<typeof registerManualPaymentSchema>;
export type ListPagosQuery = z.infer<typeof listPagosQuerySchema>;
