import { z } from 'zod';

// Token opaco hex de 32 bytes (64 chars). Aceptamos que venga con prefijo
// (Meta antepone el placeholder literal "{{1}}" al sufijo dinámico del botón);
// el controller extrae los 64 hex reales. Por eso el regex NO va anclado.
export const visitaTokenParamsSchema = z.object({
  token: z.string().min(64).max(80).regex(/[a-f0-9]{64}/i, 'token inválido'),
});

export const visitaSlotsQuerySchema = z.object({
  desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'desde debe ser YYYY-MM-DD'),
  hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'hasta debe ser YYYY-MM-DD'),
});

export const reprogramarPublicaSchema = z.object({
  // Inicio del slot elegido (ISO 8601 con offset, p.ej. 2026-06-19T09:00:00-05:00).
  fecha: z.string().min(16).max(40),
});

export const cancelarPublicaSchema = z.object({
  motivo: z.string().max(500).optional(),
});

export type VisitaTokenParams = z.infer<typeof visitaTokenParamsSchema>;
export type VisitaSlotsQuery = z.infer<typeof visitaSlotsQuerySchema>;
export type ReprogramarPublicaInput = z.infer<typeof reprogramarPublicaSchema>;
export type CancelarPublicaInput = z.infer<typeof cancelarPublicaSchema>;
