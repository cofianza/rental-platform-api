// ============================================================
// Public Properties — Validation Schemas (HP-365)
// ============================================================

import { z } from 'zod';

export const listPublicPropertiesSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(12),
  ciudad: z.string().max(100).optional(),
  tipo: z.string().max(50).optional(),
  estrato: z.coerce.number().int().min(1).max(6).optional(),
  precio_min: z.coerce.number().min(0).optional(),
  precio_max: z.coerce.number().min(0).optional(),
  habitaciones: z.coerce.number().int().min(0).optional(),
  search: z.string().max(200).optional(),
  sortBy: z.enum(['created_at', 'valor_arriendo']).default('created_at'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const propertyIdParamsSchema = z.object({
  id: z.string().uuid('ID de inmueble invalido'),
});

export type ListPublicPropertiesQuery = z.infer<typeof listPublicPropertiesSchema>;
