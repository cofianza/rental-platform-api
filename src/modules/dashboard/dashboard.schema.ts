// ============================================================
// Dashboard — Validation Schemas (HP-358)
// ============================================================

import { z } from 'zod';

const isoDateRegex = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;

export const dashboardQuerySchema = z.object({
  dateFrom: z
    .string()
    .regex(isoDateRegex, 'Formato de fecha invalido. Use ISO 8601 (ej: 2026-01-01)')
    .optional(),
  dateTo: z
    .string()
    .regex(isoDateRegex, 'Formato de fecha invalido. Use ISO 8601 (ej: 2026-12-31)')
    .optional(),
});

export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;
