import { z } from 'zod';

export const listAuditLogsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  userId: z.uuid().optional(),
  action: z.string().max(100).optional(),
  entityType: z.string().max(50).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const auditLogIdParamsSchema = z.object({
  id: z.uuid({ error: 'ID invalido' }),
});

export type ListAuditLogsQuery = z.infer<typeof listAuditLogsQuerySchema>;
export type AuditLogIdParams = z.infer<typeof auditLogIdParamsSchema>;
