import { z } from 'zod';

export const listAdminTiposQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  activo: z.enum(['true', 'false']).optional(),
  search: z.string().optional(),
});

export const tipoDocumentoIdSchema = z.object({
  id: z.uuid({ error: 'ID de tipo de documento invalido' }),
});

export const createTipoDocumentoSchema = z.object({
  codigo: z
    .string()
    .min(2, 'Codigo debe tener al menos 2 caracteres')
    .max(50, 'Codigo muy largo')
    .regex(/^[a-z0-9_]+$/, 'Codigo solo admite letras minusculas, numeros y guion bajo'),
  nombre: z.string().min(1, 'Nombre requerido').max(100, 'Nombre muy largo'),
  descripcion: z.string().max(500, 'Descripcion muy larga').nullable().optional(),
  es_obligatorio: z.boolean(),
  formatos_aceptados: z.array(z.string()).min(1, 'Al menos un formato requerido'),
  tamano_maximo_mb: z.coerce.number().min(1, 'Tamano minimo 1 MB').max(10, 'Tamano maximo 10 MB (limite del bucket)'),
  orden: z.coerce.number().int().min(0).optional(),
});

export const updateTipoDocumentoSchema = z.object({
  codigo: z
    .string()
    .min(2, 'Codigo debe tener al menos 2 caracteres')
    .max(50, 'Codigo muy largo')
    .regex(/^[a-z0-9_]+$/, 'Codigo solo admite letras minusculas, numeros y guion bajo')
    .optional(),
  nombre: z.string().min(1, 'Nombre requerido').max(100, 'Nombre muy largo').optional(),
  descripcion: z.string().max(500, 'Descripcion muy larga').nullable().optional(),
  es_obligatorio: z.boolean().optional(),
  formatos_aceptados: z.array(z.string()).min(1, 'Al menos un formato requerido').optional(),
  tamano_maximo_mb: z.coerce.number().min(1, 'Tamano minimo 1 MB').max(10, 'Tamano maximo 10 MB (limite del bucket)').optional(),
  orden: z.coerce.number().int().min(0).optional(),
});

export const reordenarTiposSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        orden: z.number().int().min(0),
      }),
    )
    .min(1, 'Al menos un item requerido'),
});

export type ListAdminTiposQuery = z.infer<typeof listAdminTiposQuerySchema>;
export type TipoDocumentoIdParams = z.infer<typeof tipoDocumentoIdSchema>;
export type CreateTipoDocumentoInput = z.infer<typeof createTipoDocumentoSchema>;
export type UpdateTipoDocumentoInput = z.infer<typeof updateTipoDocumentoSchema>;
export type ReordenarTiposInput = z.infer<typeof reordenarTiposSchema>;

export const checkCodigoQuerySchema = z.object({
  codigo: z
    .string()
    .min(2)
    .max(50)
    .regex(/^[a-z0-9_]+$/),
  excludeId: z.string().uuid().optional(),
});

export type CheckCodigoQuery = z.infer<typeof checkCodigoQuerySchema>;
