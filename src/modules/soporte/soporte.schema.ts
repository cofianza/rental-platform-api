// ============================================================
// Soporte — Validation Schemas
// ============================================================

import { z } from 'zod';

export const ticketPrioridadSchema = z.enum(['alta', 'media', 'baja']);
export const ticketEstadoSchema = z.enum(['abierto', 'en_proceso', 'resuelto']);

export const createTicketSoporteSchema = z.object({
  tipo: z.string().min(1).max(50),
  asunto: z.string().min(3).max(300),
  descripcion: z.string().max(5000).optional(),
  prioridad: ticketPrioridadSchema.optional(),
});
export type CreateTicketSoporteInput = z.infer<typeof createTicketSoporteSchema>;

export const listTicketsSoporteQuerySchema = z.object({
  estado: ticketEstadoSchema.optional(),
  prioridad: ticketPrioridadSchema.optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type ListTicketsSoporteQuery = z.infer<typeof listTicketsSoporteQuerySchema>;

export const updateTicketEstadoSchema = z.object({
  estado: ticketEstadoSchema,
});
export type UpdateTicketEstadoInput = z.infer<typeof updateTicketEstadoSchema>;

export const ticketIdParamsSchema = z.object({
  id: z.string().uuid(),
});
