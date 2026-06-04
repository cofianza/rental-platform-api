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

// Tesorería — capital disponible y reserva mínima (enteros COP, >= 0).
export const updateTesoreriaSchema = z.object({
  capitalDisponible: z.number().int().min(0, 'El capital disponible no puede ser negativo'),
  reservaMinima: z.number().int().min(0, 'La reserva mínima no puede ser negativa'),
});

export type UpdateTesoreriaInput = z.infer<typeof updateTesoreriaSchema>;

// Detalle de aliado (inmobiliaria/propietario) por id.
export const perfilIdParamsSchema = z.object({
  id: z.string().uuid('ID de perfil inválido'),
});

export type PerfilIdParams = z.infer<typeof perfilIdParamsSchema>;
