// ============================================================
// Export — Validation Schemas (HP-364)
// ============================================================

import { z } from 'zod';

const isoDateRegex = /^\d{4}-\d{2}-\d{2}/;

export const exportQuerySchema = z.object({
  format: z.enum(['csv', 'xlsx']).default('csv'),
  dateFrom: z.string().regex(isoDateRegex, 'Formato fecha invalido').optional(),
  dateTo: z.string().regex(isoDateRegex, 'Formato fecha invalido').optional(),
  estado: z.string().max(50).optional(),
  concepto: z.string().max(50).optional(),
  search: z.string().max(200).optional(),
  tipo: z.string().max(50).optional(),
  ciudad: z.string().max(100).optional(),
  estrato: z.string().max(10).optional(),
  analista_id: z.string().max(100).optional(),
  fecha_desde: z.string().optional(),
  fecha_hasta: z.string().optional(),
});

export type ExportQuery = z.infer<typeof exportQuerySchema>;
