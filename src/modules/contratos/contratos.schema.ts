import { z } from 'zod';

// ============================================================
// Params
// ============================================================

export const contratoIdParamsSchema = z.object({
  id: z.string().uuid('ID de contrato invalido'),
});

export const expedienteIdParamsSchema = z.object({
  expedienteId: z.string().uuid('ID de expediente invalido'),
});

// ============================================================
// Generar contrato
// ============================================================

export const generarContratoSchema = z.object({
  // plantilla_id es opcional: si el inmueble tiene contrato_tipo subido por
  // el propietario, se usa ese PDF en lugar de compilar desde plantilla.
  plantilla_id: z.string().uuid('ID de plantilla invalido').optional(),
  variables: z.record(z.string(), z.string()).optional(),
  fecha_inicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha invalido (YYYY-MM-DD)').optional(),
  duracion_meses: z.coerce.number().int().min(1).max(120).optional(),
  // Condiciones de fianza del contrato V4 — se persisten en el expediente.
  modalidad_fianza: z.enum(['plena', 'compartida', 'plus']).optional(),
  cotitular: z.object({
    nombre: z.string().optional(),
    tipo_documento: z.string().optional(),
    documento: z.string().optional(),
    celular: z.string().optional(),
    correo: z.string().optional(),
    direccion: z.string().optional(),
    municipio: z.string().optional(),
  }).optional(),
  servicios_reparto: z.record(z.string(), z.enum(['arrendatario', 'arrendador'])).optional(),
});

// ============================================================
// Renovar contrato (desde vigente)
// ============================================================

export const renovarContratoSchema = z.object({
  fecha_inicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha invalido (YYYY-MM-DD)').optional(),
  duracion_meses: z.coerce.number().int().min(1).max(120).optional(),
  // 4.1e: se eliminó el escape hatch `variables` — la renovación renderiza con
  // plantilla legacy plana y un override libre permitía alterar la identidad
  // del arrendatario y el canon (mismo cierre que en regenerar).
});

// ============================================================
// Regenerar contrato
// ============================================================

export const regenerarContratoSchema = z.object({
  fecha_inicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato YYYY-MM-DD').optional(),
  duracion_meses: z.coerce.number().int().min(1).max(120).optional(),
  valor_arriendo: z.coerce.number().positive().optional(),
  // 4.1e: distribución de obligaciones (quién paga cada servicio) editable
  // antes de firmar.
  servicios_reparto: z.record(z.string(), z.enum(['arrendatario', 'arrendador'])).optional(),
  // 4.1e: se ELIMINÓ el escape hatch `variables` (z.record libre) en la
  // regeneración: permitía sobreescribir CUALQUIER placeholder del contrato,
  // incluida la identidad del arrendatario (nombre/documento/correo), que el
  // ticket prohíbe modificar. Los cambios permitidos van por campos tipados.
});

// ============================================================
// List query (per-expediente)
// ============================================================

export const listContratosQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  sortBy: z.enum(['created_at']).default('created_at'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

// ============================================================
// List query (global)
// ============================================================

export const listAllContratosQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  sortBy: z.enum(['created_at', 'fecha_generacion', 'estado']).default('created_at'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
  estado: z.string().max(200).optional(),
  search: z.string().max(200).optional(),
  fecha_desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  fecha_hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

// ============================================================
// Version endpoints
// ============================================================

export const versionDescargarParamsSchema = z.object({
  id: z.string().uuid('ID de contrato invalido'),
  versionNum: z.coerce.number().int().min(1, 'Numero de version invalido'),
});

export const compararVersionesQuerySchema = z.object({
  v1: z.coerce.number().int().min(1, 'Version v1 invalida'),
  v2: z.coerce.number().int().min(1, 'Version v2 invalida'),
});

// ============================================================
// Type exports
// ============================================================

export type ContratoIdParams = z.infer<typeof contratoIdParamsSchema>;
export type ExpedienteIdParams = z.infer<typeof expedienteIdParamsSchema>;
export type GenerarContratoInput = z.infer<typeof generarContratoSchema>;
export type RenovarContratoInput = z.infer<typeof renovarContratoSchema>;
export type ReGenerarContratoInput = z.infer<typeof regenerarContratoSchema>;
export type ListContratosQuery = z.infer<typeof listContratosQuerySchema>;
export type ListAllContratosQuery = z.infer<typeof listAllContratosQuerySchema>;
export type VersionDescargarParams = z.infer<typeof versionDescargarParamsSchema>;
export type CompararVersionesQuery = z.infer<typeof compararVersionesQuerySchema>;
