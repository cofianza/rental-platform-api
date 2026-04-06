// ============================================================
// Reportes — Validation Schemas (HP-360)
// ============================================================

import { z } from 'zod';

const isoDateRegex = /^\d{4}-\d{2}-\d{2}/;

export const volumenQuerySchema = z.object({
  dateFrom: z.string().regex(isoDateRegex, 'Formato fecha invalido (ISO 8601)').optional(),
  dateTo: z.string().regex(isoDateRegex, 'Formato fecha invalido (ISO 8601)').optional(),
  estado: z.string().max(50).optional(),
});

export type VolumenQuery = z.infer<typeof volumenQuerySchema>;

// HP-361: Aprobacion
export const aprobacionQuerySchema = z.object({
  dateFrom: z.string().regex(isoDateRegex, 'Formato fecha invalido (ISO 8601)').optional(),
  dateTo: z.string().regex(isoDateRegex, 'Formato fecha invalido (ISO 8601)').optional(),
});

export type AprobacionQuery = z.infer<typeof aprobacionQuerySchema>;

// HP-362: Ingresos
export const ingresosQuerySchema = z.object({
  dateFrom: z.string().regex(isoDateRegex, 'Formato fecha invalido (ISO 8601)').optional(),
  dateTo: z.string().regex(isoDateRegex, 'Formato fecha invalido (ISO 8601)').optional(),
  concepto: z.string().max(50).optional(),
});

export type IngresosQuery = z.infer<typeof ingresosQuerySchema>;

// HP-363: Tiempos por etapa
export const tiemposQuerySchema = z.object({
  dateFrom: z.string().regex(isoDateRegex, 'Formato fecha invalido (ISO 8601)').optional(),
  dateTo: z.string().regex(isoDateRegex, 'Formato fecha invalido (ISO 8601)').optional(),
});

export type TiemposQuery = z.infer<typeof tiemposQuerySchema>;
