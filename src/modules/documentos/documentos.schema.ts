import { z } from 'zod';

// ============================================================
// Enums
// ============================================================

const ESTADOS_DOCUMENTO = ['pendiente', 'aprobado', 'rechazado', 'reemplazado'] as const;

// ============================================================
// Param schemas
// ============================================================

export const documentoIdParamsSchema = z.object({
  id: z.uuid({ error: 'ID de documento invalido' }),
});

export const expedienteIdParamsSchema = z.object({
  expedienteId: z.uuid({ error: 'ID de expediente invalido' }),
});

// ============================================================
// POST /presigned-url
// ============================================================

export const presignedUrlSchema = z.object({
  expediente_id: z.uuid({ error: 'ID de expediente invalido' }),
  tipo_documento_id: z.uuid({ error: 'ID de tipo de documento invalido' }),
  nombre_original: z.string()
    .min(1, 'Nombre del archivo requerido')
    .max(255, 'Nombre del archivo no debe exceder 255 caracteres'),
  tipo_mime: z.string()
    .min(1, 'Tipo MIME requerido')
    .max(100, 'Tipo MIME no debe exceder 100 caracteres'),
  tamano_bytes: z.coerce.number()
    .int('Tamano debe ser un entero')
    .positive('El tamano del archivo debe ser positivo'),
});

// ============================================================
// POST /confirmar-subida
// ============================================================

// HP-327: Schema para metadatos de captura (selfie, etc.)
const metadatosSchema = z.object({
  metodo_captura: z.enum(['camara', 'archivo']).optional(),
  timestamp_captura: z.string().optional(),
  user_agent: z.string().max(500).optional(),
}).optional();

export const confirmarSubidaSchema = z.object({
  expediente_id: z.uuid({ error: 'ID de expediente invalido' }),
  tipo_documento_id: z.uuid({ error: 'ID de tipo de documento invalido' }),
  nombre_original: z.string().min(1, 'Nombre original requerido').max(255, 'Nombre muy largo'),
  nombre_archivo: z.string().min(1, 'Nombre de archivo requerido').max(255, 'Nombre muy largo'),
  storage_key: z.string().min(1, 'Storage key requerido').max(500, 'Storage key muy largo'),
  tipo_mime: z.string().min(1, 'Tipo MIME requerido').max(100, 'Tipo MIME muy largo'),
  tamano_bytes: z.coerce.number().int().positive('Tamano debe ser positivo'),
  metadatos: metadatosSchema,
});

// ============================================================
// GET /expedientes/:expedienteId/documentos
// ============================================================

export const listDocumentosQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  tipo_documento_id: z.uuid({ error: 'ID de tipo de documento invalido' }).optional(),
  estado: z.enum(ESTADOS_DOCUMENTO, { error: `Estado invalido. Valores: ${ESTADOS_DOCUMENTO.join(', ')}` }).optional(),
  sortBy: z.enum(['created_at', 'nombre_original', 'estado']).default('created_at'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

// ============================================================
// PATCH /:id/rechazar
// ============================================================

export const rechazarDocumentoSchema = z.object({
  motivo_rechazo: z.string()
    .min(10, 'El motivo debe tener al menos 10 caracteres')
    .max(500, 'El motivo no debe exceder 500 caracteres'),
});

// ============================================================
// POST /:id/reemplazar
// ============================================================

export const reemplazarDocumentoSchema = z.object({
  nombre_original: z.string().min(1, 'Nombre del archivo requerido').max(255),
  tipo_mime: z.string().min(1, 'Tipo MIME requerido').max(100),
  tamano_bytes: z.coerce.number().int().positive('Tamano debe ser positivo'),
});

// ============================================================
// POST /:id/confirmar-reemplazo
// ============================================================

export const confirmarReemplazoSchema = z.object({
  nombre_original: z.string().min(1, 'Nombre original requerido').max(255),
  nombre_archivo: z.string().min(1, 'Nombre de archivo requerido').max(255),
  storage_key: z.string().min(1, 'Storage key requerido').max(500),
  tipo_mime: z.string().min(1, 'Tipo MIME requerido').max(100),
  tamano_bytes: z.coerce.number().int().positive('Tamano debe ser positivo'),
  metadatos: metadatosSchema, // D1 CR: metadatos para reemplazo de selfie
});

// ============================================================
// Type exports
// ============================================================

export type DocumentoIdParams = z.infer<typeof documentoIdParamsSchema>;
export type ExpedienteIdParams = z.infer<typeof expedienteIdParamsSchema>;
export type PresignedUrlInput = z.infer<typeof presignedUrlSchema>;
export type ConfirmarSubidaInput = z.infer<typeof confirmarSubidaSchema>;
export type ListDocumentosQuery = z.infer<typeof listDocumentosQuerySchema>;
export type RechazarDocumentoInput = z.infer<typeof rechazarDocumentoSchema>;
export type ReemplazarDocumentoInput = z.infer<typeof reemplazarDocumentoSchema>;
export type ConfirmarReemplazoInput = z.infer<typeof confirmarReemplazoSchema>;
