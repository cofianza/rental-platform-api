import { z } from 'zod';
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
  // Responsable (miembro de la inmobiliaria) elegido al crear (Fase 3.1).
  // null = sin asignar; omitir = auto-asignar al creador si es miembro.
  miembro_responsable_id: z.uuid({ error: 'ID de miembro invalido' }).nullable().optional(),
  notas: z.string().max(5000, { error: 'Notas no deben exceder 5000 caracteres' }).optional(),
  // Coarrendatario (opcional). Se llenan automáticamente cuando un
  // coarrendatario invitado acepta y termina su estudio (ver coarrendatarios
  // service); admin/operador también puede llenarlas a mano para flujos
  // manuales.
  coarrendatario_nombre: z.string().max(200, { error: 'Nombre del coarrendatario no debe exceder 200 caracteres' }).optional(),
  coarrendatario_tipo_documento: z.enum(TIPOS_DOCUMENTO, {
    error: `Tipo de documento del coarrendatario invalido. Valores permitidos: ${TIPOS_DOCUMENTO.join(', ')}`,
  }).optional(),
  coarrendatario_documento: z.string().max(20, { error: 'Documento del coarrendatario no debe exceder 20 caracteres' }).optional(),
  coarrendatario_parentesco: z.string().max(50, { error: 'Parentesco del coarrendatario no debe exceder 50 caracteres' }).optional(),
});

// ============================================================
// Update schema (solo notas y analista_id editables)
// ============================================================

export const updateExpedienteSchema = z.object({
  analista_id: z.uuid({ error: 'ID de analista invalido' }).nullable().optional(),
  notas: z.string().max(5000, { error: 'Notas no deben exceder 5000 caracteres' }).nullable().optional(),
  // Coarrendatario editable tambien.
  coarrendatario_nombre: z.string().max(200).nullable().optional(),
  coarrendatario_tipo_documento: z.enum(TIPOS_DOCUMENTO, {
    error: `Tipo de documento del coarrendatario invalido. Valores permitidos: ${TIPOS_DOCUMENTO.join(', ')}`,
  }).nullable().optional(),
  coarrendatario_documento: z.string().max(20).nullable().optional(),
  coarrendatario_parentesco: z.string().max(50).nullable().optional(),
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
  inmueble_id: z.uuid({ error: 'ID de inmueble invalido' }).optional(), // HP-247: filtrar por inmueble
  fecha_desde: z.string().optional(),
  fecha_hasta: z.string().optional(),
  sortBy: z.enum(['created_at', 'numero', 'estado']).default('created_at'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

// Asignar miembro responsable del expediente (Fase 3.1). miembro_id null = quitar.
export const asignarResponsableExpedienteSchema = z.object({
  miembro_id: z.string().uuid({ message: 'ID de miembro inválido' }).nullable(),
});

// ============================================================
// Type exports
// ============================================================

export type AsignarResponsableExpedienteInput = z.infer<typeof asignarResponsableExpedienteSchema>;
export type CreateExpedienteInput = z.infer<typeof createExpedienteSchema>;
export type UpdateExpedienteInput = z.infer<typeof updateExpedienteSchema>;
export type ListExpedientesQuery = z.infer<typeof listExpedientesQuerySchema>;
