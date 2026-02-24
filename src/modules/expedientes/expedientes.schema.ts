import { z } from 'zod';
import { ESTADOS_EXPEDIENTE } from './expediente-state-machine';
import { TIPOS_DOCUMENTO } from '../solicitantes/solicitantes.schema';

// Reusar del workflow schema
export { expedienteIdParamsSchema } from './expediente-workflow.schema';
export type { ExpedienteIdParams } from './expediente-workflow.schema';

// ============================================================
// Create schema
// ============================================================

export const createExpedienteSchema = z.object({
  inmueble_id: z.uuid({ error: 'ID de inmueble invalido' }),
  solicitante_id: z.uuid({ error: 'ID de solicitante invalido' }),
  analista_id: z.uuid({ error: 'ID de analista invalido' }).optional(),
  notas: z.string().max(5000, 'Notas no deben exceder 5000 caracteres').optional(),
  // Codeudor (opcional)
  codeudor_nombre: z.string().max(200, 'Nombre del codeudor no debe exceder 200 caracteres').optional(),
  codeudor_tipo_documento: z.enum(TIPOS_DOCUMENTO, {
    error: `Tipo de documento del codeudor invalido. Valores permitidos: ${TIPOS_DOCUMENTO.join(', ')}`,
  }).optional(),
  codeudor_documento: z.string().max(20, 'Documento del codeudor no debe exceder 20 caracteres').optional(),
  codeudor_parentesco: z.string().max(50, 'Parentesco del codeudor no debe exceder 50 caracteres').optional(),
});

// ============================================================
// Update schema (solo notas y analista_id editables)
// ============================================================

export const updateExpedienteSchema = z.object({
  analista_id: z.uuid({ error: 'ID de analista invalido' }).nullable().optional(),
  notas: z.string().max(5000, 'Notas no deben exceder 5000 caracteres').nullable().optional(),
  // Codeudor editable tambien
  codeudor_nombre: z.string().max(200).nullable().optional(),
  codeudor_tipo_documento: z.enum(TIPOS_DOCUMENTO, {
    error: `Tipo de documento del codeudor invalido. Valores permitidos: ${TIPOS_DOCUMENTO.join(', ')}`,
  }).nullable().optional(),
  codeudor_documento: z.string().max(20).nullable().optional(),
  codeudor_parentesco: z.string().max(50).nullable().optional(),
});

// ============================================================
// List query schema
// ============================================================

export const listExpedientesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  estado: z.string().optional(), // Comma-separated: "borrador,en_revision"
  analista_id: z.uuid({ error: 'ID de analista invalido' }).optional(),
  fecha_desde: z.string().optional(),
  fecha_hasta: z.string().optional(),
  sortBy: z.enum(['created_at', 'numero', 'estado']).default('created_at'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

// ============================================================
// Type exports
// ============================================================

export type CreateExpedienteInput = z.infer<typeof createExpedienteSchema>;
export type UpdateExpedienteInput = z.infer<typeof updateExpedienteSchema>;
export type ListExpedientesQuery = z.infer<typeof listExpedientesQuerySchema>;
