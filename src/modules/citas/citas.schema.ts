import { z } from 'zod';

// ============================================================
// Estados de cita
// ============================================================

export const ESTADOS_CITA = ['solicitada', 'confirmada', 'realizada', 'cancelada', 'no_asistio'] as const;
export type EstadoCita = (typeof ESTADOS_CITA)[number];

// ============================================================
// Create
// ============================================================

export const createCitaSchema = z.object({
  expediente_id: z.uuid({ error: 'ID de expediente invalido' }),
  fecha_propuesta: z.string().datetime({ offset: true, message: 'Fecha propuesta debe ser una fecha/hora valida en formato ISO 8601' }),
  notas_solicitante: z.string().max(2000, { error: 'Notas no deben exceder 2000 caracteres' }).optional(),
  // Solo propietario/inmobiliaria/admin pueden marcar como confirmada al crear
  confirmar_inmediatamente: z.boolean().optional(),
});

// ============================================================
// Confirmar
// ============================================================

export const confirmarCitaSchema = z.object({
  fecha_confirmada: z.string().datetime({ offset: true, message: 'Fecha confirmada debe ser una fecha/hora valida en formato ISO 8601' }).optional(),
  notas_propietario: z.string().max(2000, { error: 'Notas no deben exceder 2000 caracteres' }).optional(),
});

// ============================================================
// Realizar
// ============================================================

export const realizarCitaSchema = z.object({
  notas_propietario: z.string().max(2000, { error: 'Notas no deben exceder 2000 caracteres' }).optional(),
});

// ============================================================
// Cancelar
// ============================================================

export const cancelarCitaSchema = z.object({
  motivo_cancelacion: z.string().min(1, { error: 'Motivo de cancelacion es requerido' }).max(2000, { error: 'Motivo no debe exceder 2000 caracteres' }),
});

// ============================================================
// Params
// ============================================================

export const citaIdParamsSchema = z.object({
  id: z.uuid({ error: 'ID de cita invalido' }),
});

// ============================================================
// List query
// ============================================================

export const listCitasQuerySchema = z.object({
  expediente_id: z.uuid({ error: 'ID de expediente invalido' }).optional(),
  estado: z.enum(ESTADOS_CITA, { error: `Estado invalido. Valores permitidos: ${ESTADOS_CITA.join(', ')}` }).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// ============================================================
// Type exports
// ============================================================

export type CreateCitaInput = z.infer<typeof createCitaSchema>;
export type ConfirmarCitaInput = z.infer<typeof confirmarCitaSchema>;
export type RealizarCitaInput = z.infer<typeof realizarCitaSchema>;
export type CancelarCitaInput = z.infer<typeof cancelarCitaSchema>;
export type CitaIdParams = z.infer<typeof citaIdParamsSchema>;
export type ListCitasQuery = z.infer<typeof listCitasQuerySchema>;
