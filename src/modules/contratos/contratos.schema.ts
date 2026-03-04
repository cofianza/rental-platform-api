import { z } from 'zod';

// ============================================================
// Params
// ============================================================

export const contratoIdParamsSchema = z.object({
  id: z.string().uuid('ID de contrato invalido'),
});

export const expedienteIdParamsSchema = z.object({
  expedienteId: z.string().uuid('ID de expediente invalido'),
});

// ============================================================
// Generar contrato
// ============================================================

export const generarContratoSchema = z.object({
  plantilla_id: z.string().uuid('ID de plantilla invalido'),
  variables: z.record(z.string(), z.string()).optional(),
  fecha_inicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha invalido (YYYY-MM-DD)').optional(),
  duracion_meses: z.coerce.number().int().min(1).max(120).optional(),
});

// ============================================================
// Regenerar contrato
// ============================================================

export const regenerarContratoSchema = z.object({
  variables: z.record(z.string(), z.string()).optional(),
});

// ============================================================
// List query
// ============================================================

export const listContratosQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  sortBy: z.enum(['created_at']).default('created_at'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

// ============================================================
// Type exports
// ============================================================

export type ContratoIdParams = z.infer<typeof contratoIdParamsSchema>;
export type ExpedienteIdParams = z.infer<typeof expedienteIdParamsSchema>;
export type GenerarContratoInput = z.infer<typeof generarContratoSchema>;
export type ReGenerarContratoInput = z.infer<typeof regenerarContratoSchema>;
export type ListContratosQuery = z.infer<typeof listContratosQuerySchema>;
