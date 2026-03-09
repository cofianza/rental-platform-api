import { z } from 'zod';

// Standard variables available for templates
export const STANDARD_VARIABLES = [
  'arrendador_nombre',
  'arrendador_documento',
  'arrendatario_nombre',
  'arrendatario_documento',
  'inmueble_direccion',
  'inmueble_ciudad',
  'canon_mensual',
  'fecha_inicio',
  'fecha_fin',
  'duracion_meses',
  'deposito',
  'clausulas_adicionales',
] as const;

// ============================================================
// Params
// ============================================================

export const plantillaIdParamsSchema = z.object({
  id: z.string().uuid('ID de plantilla invalido'),
});

// ============================================================
// Create
// ============================================================

export const createPlantillaSchema = z.object({
  nombre: z.string()
    .min(1, 'El nombre es requerido')
    .max(200, 'Nombre no debe exceder 200 caracteres'),
  descripcion: z.string()
    .max(1000, 'Descripcion no debe exceder 1000 caracteres')
    .optional(),
  contenido: z.string()
    .min(1, 'El contenido es requerido'),
  activa: z.boolean().default(true),
});

// ============================================================
// Update
// ============================================================

export const updatePlantillaSchema = z.object({
  nombre: z.string()
    .min(1, 'El nombre es requerido')
    .max(200, 'Nombre no debe exceder 200 caracteres')
    .optional(),
  descripcion: z.string()
    .max(1000, 'Descripcion no debe exceder 1000 caracteres')
    .nullable()
    .optional(),
  contenido: z.string()
    .min(1, 'El contenido no puede estar vacio')
    .optional(),
  activa: z.boolean().optional(),
});

// ============================================================
// List query
// ============================================================

export const listPlantillasQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().optional(),
  activa: z.enum(['true', 'false']).optional(),
  sortBy: z.enum(['created_at', 'nombre', 'version']).default('created_at'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

// ============================================================
// Preview
// ============================================================

export const previewPlantillaSchema = z.object({
  variables: z.record(z.string(), z.string()).optional(),
});

// ============================================================
// Type exports
// ============================================================

export type PlantillaIdParams = z.infer<typeof plantillaIdParamsSchema>;
export type CreatePlantillaInput = z.infer<typeof createPlantillaSchema>;
export type UpdatePlantillaInput = z.infer<typeof updatePlantillaSchema>;
export type ListPlantillasQuery = z.infer<typeof listPlantillasQuerySchema>;
export type PreviewPlantillaInput = z.infer<typeof previewPlantillaSchema>;
