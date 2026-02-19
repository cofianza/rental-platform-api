/**
 * Schemas de validación para fotos de inmuebles - HP-203
 */
import { z } from 'zod';

// Constantes
export const FOTO_LIMITS = {
  MAX_FOTOS_PER_INMUEBLE: 20,
  MAX_FILE_SIZE: 5 * 1024 * 1024, // 5MB
  ALLOWED_TYPES: ['image/jpeg', 'image/png', 'image/webp'] as const,
} as const;

// Params
export const fotoIdParamsSchema = z.object({
  id: z.string().uuid('ID de inmueble inválido'),
  fotoId: z.string().uuid('ID de foto inválido'),
});

export const inmuebleIdOnlyParamsSchema = z.object({
  id: z.string().uuid('ID de inmueble inválido'),
});

// Body schemas
export const createFotoSchema = z.object({
  url: z.string().url('URL de imagen inválida'),
  url_thumbnail: z.string().url('URL de thumbnail inválida').optional().nullable(),
  descripcion: z.string().max(500, 'Descripción muy larga').optional().nullable(),
  orden: z.coerce.number().int().min(0, 'Orden no puede ser negativo').default(0),
  es_fachada: z.boolean().default(false),
  tamaño_archivo: z.coerce.number().int().min(0).optional().nullable(),
  tipo_archivo: z.string().max(50).optional().nullable(),
});

export const updateFotoSchema = z.object({
  descripcion: z.string().max(500, 'Descripción muy larga').optional().nullable(),
  orden: z.coerce.number().int().min(0, 'Orden no puede ser negativo').optional(),
  es_fachada: z.boolean().optional(),
});

export const reordenarFotosSchema = z.object({
  foto_ids: z.array(z.string().uuid('ID de foto inválido')).min(1, 'Se requiere al menos un ID de foto'),
});

export const setFachadaSchema = z.object({
  foto_id: z.string().uuid('ID de foto inválido'),
});

// Types
export type FotoIdParams = z.infer<typeof fotoIdParamsSchema>;
export type InmuebleIdOnlyParams = z.infer<typeof inmuebleIdOnlyParamsSchema>;
export type CreateFotoInput = z.infer<typeof createFotoSchema>;
export type UpdateFotoInput = z.infer<typeof updateFotoSchema>;
export type ReordenarFotosInput = z.infer<typeof reordenarFotosSchema>;
export type SetFachadaInput = z.infer<typeof setFachadaSchema>;
