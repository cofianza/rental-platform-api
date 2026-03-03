import { z } from 'zod';

// ============================================================
// Constantes de enums
// ============================================================

export const TIPOS_DOCUMENTO = ['cc', 'ce', 'pasaporte', 'nit'] as const;

export const TIPOS_PERSONA = ['natural', 'juridica'] as const;

export const NIVELES_EDUCATIVOS = [
  'primaria',
  'secundaria',
  'tecnico',
  'universitario',
  'posgrado',
] as const;

export const DEPARTAMENTOS_COLOMBIA = [
  'Amazonas',
  'Antioquia',
  'Arauca',
  'Atlantico',
  'Bogota D.C.',
  'Bolivar',
  'Boyaca',
  'Caldas',
  'Caqueta',
  'Casanare',
  'Cauca',
  'Cesar',
  'Choco',
  'Cordoba',
  'Cundinamarca',
  'Guainia',
  'Guaviare',
  'Huila',
  'La Guajira',
  'Magdalena',
  'Meta',
  'Narino',
  'Norte de Santander',
  'Putumayo',
  'Quindio',
  'Risaralda',
  'San Andres y Providencia',
  'Santander',
  'Sucre',
  'Tolima',
  'Valle del Cauca',
  'Vaupes',
  'Vichada',
] as const;

// ============================================================
// Param schemas
// ============================================================

export const applicantIdParamsSchema = z.object({
  id: z.uuid({ error: 'ID de solicitante invalido' }),
});

// ============================================================
// Create schema
// ============================================================

export const createApplicantSchema = z.object({
  // Obligatorios
  tipo_persona: z.enum(TIPOS_PERSONA, {
    error: `Tipo de persona invalido. Valores permitidos: ${TIPOS_PERSONA.join(', ')}`,
  }),
  nombre: z.string().min(1, 'Nombre es requerido').max(100, 'Nombre no debe exceder 100 caracteres'),
  apellido: z.string().min(1, 'Apellido es requerido').max(100, 'Apellido no debe exceder 100 caracteres'),
  tipo_documento: z.enum(TIPOS_DOCUMENTO, {
    error: `Tipo de documento invalido. Valores permitidos: ${TIPOS_DOCUMENTO.join(', ')}`,
  }),
  numero_documento: z.string().min(1, 'Numero de documento es requerido').max(20, 'Numero de documento no debe exceder 20 caracteres'),
  email: z.email({ error: 'Email invalido' }),
  // Opcionales
  telefono: z.string().max(20, 'Telefono no debe exceder 20 caracteres').optional(),
  direccion: z.string().max(300, 'Direccion no debe exceder 300 caracteres').optional(),
  departamento: z.enum(DEPARTAMENTOS_COLOMBIA, {
    error: `Departamento invalido. Debe ser un departamento colombiano valido`,
  }).optional(),
  ciudad: z.string().max(100, 'Ciudad no debe exceder 100 caracteres').optional(),
  ocupacion: z.string().max(100, 'Ocupacion no debe exceder 100 caracteres').optional(),
  actividad_economica: z.string().max(200, 'Actividad economica no debe exceder 200 caracteres').optional(),
  empresa: z.string().max(200, 'Nombre del empleador no debe exceder 200 caracteres').optional(),
  ingresos_mensuales: z.coerce.number().min(0, 'Ingresos mensuales no puede ser negativo').optional(),
  nivel_educativo: z.enum(NIVELES_EDUCATIVOS, {
    error: `Nivel educativo invalido. Valores permitidos: ${NIVELES_EDUCATIVOS.join(', ')}`,
  }).optional(),
  parentesco: z.string().max(50, 'Parentesco no debe exceder 50 caracteres').optional(),
  habitara_inmueble: z.boolean().default(false),
});

// ============================================================
// Update schema (todos los campos opcionales para PATCH parcial)
// ============================================================

export const updateApplicantSchema = z.object({
  tipo_persona: z.enum(TIPOS_PERSONA, {
    error: `Tipo de persona invalido. Valores permitidos: ${TIPOS_PERSONA.join(', ')}`,
  }).optional(),
  nombre: z.string().min(1, 'Nombre es requerido').max(100, 'Nombre no debe exceder 100 caracteres').optional(),
  apellido: z.string().min(1, 'Apellido es requerido').max(100, 'Apellido no debe exceder 100 caracteres').optional(),
  tipo_documento: z.enum(TIPOS_DOCUMENTO, {
    error: `Tipo de documento invalido. Valores permitidos: ${TIPOS_DOCUMENTO.join(', ')}`,
  }).optional(),
  numero_documento: z.string().min(1, 'Numero de documento es requerido').max(20, 'Numero de documento no debe exceder 20 caracteres').optional(),
  email: z.email({ error: 'Email invalido' }).optional(),
  telefono: z.string().max(20, 'Telefono no debe exceder 20 caracteres').nullable().optional(),
  direccion: z.string().max(300, 'Direccion no debe exceder 300 caracteres').nullable().optional(),
  departamento: z.enum(DEPARTAMENTOS_COLOMBIA, {
    error: `Departamento invalido. Debe ser un departamento colombiano valido`,
  }).nullable().optional(),
  ciudad: z.string().max(100, 'Ciudad no debe exceder 100 caracteres').nullable().optional(),
  ocupacion: z.string().max(100, 'Ocupacion no debe exceder 100 caracteres').nullable().optional(),
  actividad_economica: z.string().max(200, 'Actividad economica no debe exceder 200 caracteres').nullable().optional(),
  empresa: z.string().max(200, 'Nombre del empleador no debe exceder 200 caracteres').nullable().optional(),
  ingresos_mensuales: z.coerce.number().min(0, 'Ingresos mensuales no puede ser negativo').nullable().optional(),
  nivel_educativo: z.enum(NIVELES_EDUCATIVOS, {
    error: `Nivel educativo invalido. Valores permitidos: ${NIVELES_EDUCATIVOS.join(', ')}`,
  }).nullable().optional(),
  parentesco: z.string().max(50, 'Parentesco no debe exceder 50 caracteres').nullable().optional(),
  habitara_inmueble: z.boolean().optional(),
});

// ============================================================
// List query schema
// ============================================================

export const listApplicantsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  sortBy: z.enum(['created_at', 'nombre', 'apellido', 'email', 'numero_documento']).default('created_at'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  include_inactive: z.enum(['true', 'false']).optional(),
});

// ============================================================
// Search by document query schema
// ============================================================

export const searchByDocumentQuerySchema = z.object({
  document_type: z.enum(TIPOS_DOCUMENTO, {
    error: `Tipo de documento invalido. Valores permitidos: ${TIPOS_DOCUMENTO.join(', ')}`,
  }),
  document_number: z.string().min(1, 'Numero de documento es requerido'),
});

// ============================================================
// Type exports
// ============================================================

export type ApplicantIdParams = z.infer<typeof applicantIdParamsSchema>;
export type CreateApplicantInput = z.infer<typeof createApplicantSchema>;
export type UpdateApplicantInput = z.infer<typeof updateApplicantSchema>;
export type ListApplicantsQuery = z.infer<typeof listApplicantsQuerySchema>;
export type SearchByDocumentQuery = z.infer<typeof searchByDocumentQuerySchema>;
