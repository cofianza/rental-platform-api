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
  pagoId: z.uuid({ error: 'ID de pago invalido' }),
});

export const expedienteIdParamsSchema = z.object({
  expedienteId: z.uuid({ error: 'ID de expediente invalido' }),
});

// ============================================================
// Create payment link (via gateway) — POST /expedientes/:expedienteId/pagos
// ============================================================

export const createPaymentLinkSchema = z.object({
  concepto: z.enum(CONCEPTOS_PAGO, { error: 'Concepto invalido' }),
  monto: z.number().int().positive('Monto debe ser un entero positivo en COP'),
  descripcion: z.string().max(500).min(1, 'Descripcion es requerida'),
  email_pagador: z.email({ error: 'Email del pagador invalido' }),
  nombre_pagador: z.string().min(1, 'Nombre del pagador es requerido').max(200),
  enviar_email: z.boolean().default(true),
});

// ============================================================
// Register manual payment — POST /expedientes/:expedienteId/pagos/manual
// ============================================================

export const registerManualPaymentSchema = z.object({
  concepto: z.enum(CONCEPTOS_PAGO, { error: 'Concepto invalido' }),
  monto: z.number().int().positive('Monto debe ser un entero positivo en COP'),
  metodo: z.enum(['transferencia', 'efectivo', 'cheque'] as const, { error: 'Metodo de pago invalido' }),
  descripcion: z.string().max(500).optional(),
  referencia_bancaria: z.string().max(255).optional(),
  notas: z.string().max(2000).optional(),
  fecha_pago: z.string().min(1, 'Fecha de pago es requerida'),
  // Comprobante file metadata (from presigned URL flow)
  comprobante_storage_key: z.string().max(500).optional(),
  comprobante_nombre_original: z.string().max(255).optional(),
  comprobante_tipo_mime: z.string().max(100).optional(),
  comprobante_tamano_bytes: z.number().int().positive().optional(),
});

// ============================================================
// Presigned URL for comprobante upload
// ============================================================

const COMPROBANTE_MIMES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
const COMPROBANTE_MAX_MB = 5;

export const comprobantePresignedUrlSchema = z.object({
  nombre_original: z.string().min(1).max(255),
  tipo_mime: z.enum(COMPROBANTE_MIMES, { error: 'Solo se aceptan archivos PDF, JPG o PNG' }),
  tamano_bytes: z.coerce.number().int().positive().max(COMPROBANTE_MAX_MB * 1024 * 1024, `Archivo excede el limite de ${COMPROBANTE_MAX_MB}MB`),
});

// ============================================================
// List query
// ============================================================

export const listPagosQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  concepto: z.string().optional(),
  estado: z.string().optional(),
  sortBy: z.enum(['created_at', 'monto', 'fecha_pago']).default('created_at'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

// ============================================================
// Type exports
// ============================================================

export type PagoIdParams = z.infer<typeof pagoIdParamsSchema>;
export type ExpedienteIdParams = z.infer<typeof expedienteIdParamsSchema>;
export type CreatePaymentLinkInput = z.infer<typeof createPaymentLinkSchema>;
export type RegisterManualPaymentInput = z.infer<typeof registerManualPaymentSchema>;
export type ComprobantePresignedUrlInput = z.infer<typeof comprobantePresignedUrlSchema>;
export type ListPagosQuery = z.infer<typeof listPagosQuerySchema>;
