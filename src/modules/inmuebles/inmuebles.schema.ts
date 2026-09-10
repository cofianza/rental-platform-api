import { z } from 'zod';

const TIPOS_INMUEBLE = [
  'apartamento', 'casa', 'oficina', 'local', 'bodega',
  'apartaestudio', 'casa_finca', 'finca', 'lote', 'parqueadero',
] as const;
// Incluye todos los valores válidos del enum de BD (para validar filas
// existentes 'local_comercial') + 'mixto'; la UI ofrece Vivienda/Comercio/Mixto.
const USOS_INMUEBLE = ['vivienda', 'comercial', 'local_comercial', 'mixto'] as const;
const ESTADOS_INMUEBLE = ['disponible', 'en_estudio', 'ocupado', 'inactivo'] as const;

export const inmuebleIdParamsSchema = z.object({
  id: z.uuid({ error: 'ID de inmueble inválido' }),
});

// Regex del codigo: alphanumeric + guiones/underscores/espacios. Mario quiere
// que cada inmobiliaria defina su propio sistema (APT-001, CASA-SAB, etc), asi
// que el formato es libre pero limitado a chars seguros para reportes/CSV.
const CODIGO_INMUEBLE_REGEX = /^[A-Za-z0-9][A-Za-z0-9 _-]*$/;

export const createInmuebleSchema = z.object({
  codigo: z
    .string()
    .min(1, 'Código requerido')
    .max(30, 'Código no puede exceder 30 caracteres')
    .regex(CODIGO_INMUEBLE_REGEX, 'Código inválido: solo letras, números, guiones, guiones bajos y espacios')
    .transform((v) => v.trim()),
  direccion: z.string().min(1, 'Dirección requerida').max(300, 'Dirección muy larga'),
  ciudad: z.string().min(1, 'Ciudad requerida').max(100, 'Ciudad muy larga'),
  barrio: z.string().max(100, 'Barrio muy largo').optional(),
  departamento: z.string().min(1, 'Departamento requerido').max(100, 'Departamento muy largo'),
  tipo: z.enum(TIPOS_INMUEBLE, { error: `Tipo inválido. Valores permitidos: ${TIPOS_INMUEBLE.join(', ')}` }),
  uso: z.enum(USOS_INMUEBLE, { error: `Uso inválido. Valores permitidos: ${USOS_INMUEBLE.join(', ')}` }).default('vivienda'),
  destinacion: z.string().max(500, 'Destinacion muy larga').optional(),
  estrato: z.coerce.number().int().min(1, 'Estrato mínimo es 1').max(7, 'Estrato máximo es 7'),
  valor_arriendo: z.coerce.number().positive('Valor de arriendo debe ser mayor a 0').max(999999999, 'Valor de arriendo no puede superar $999.999.999'),
  valor_comercial: z.coerce.number().positive('Valor comercial debe ser mayor a 0').max(99999999999, 'Valor comercial no puede superar $99.999.999.999').optional(),
  administracion: z.coerce.number().min(0, 'Administracion no puede ser negativa').max(999999999, 'Administracion no puede superar $999.999.999').default(0),
  area_m2: z.coerce.number().positive('Área debe ser mayor a 0').max(99999, 'Área no puede superar 99.999 m²').optional(),
  habitaciones: z.coerce.number().int().min(0, 'Habitaciones no puede ser negativo').max(99, 'Máximo 99 habitaciones').default(0),
  banos: z.coerce.number().int().min(0, 'Banos no puede ser negativo').max(99, 'Máximo 99 baños').default(0),
  parqueadero: z.boolean().default(false),
  parqueaderos: z.coerce.number().int().min(0, 'Parqueaderos no puede ser negativo').max(99, 'Máximo 99 parqueaderos').default(0),
  piso: z.string().max(10, 'Piso muy largo').optional(),
  latitud: z.coerce.number().min(-90, 'Latitud inválida').max(90, 'Latitud inválida').optional(),
  longitud: z.coerce.number().min(-180, 'Longitud inválida').max(180, 'Longitud inválida').optional(),
  descripcion: z.string().max(2000, 'Descripción muy larga').optional(),
  notas_internas: z.string().max(2000, 'Notas muy largas').optional(),
  propietario_id: z.uuid({ error: 'ID de propietario inválido' }),
  visible_vitrina: z.boolean().default(false),
  foto_fachada_url: z.url({ error: 'URL de foto de fachada inválida' }),
  // Datos para contrato (clausulas PRIMERA y SEGUNDA del contrato).
  propiedad_horizontal: z.boolean().nullable().optional(),
  cuarto_util: z.boolean().default(false),
  ubicacion_detallada: z.string().max(1000, 'Ubicación detallada muy larga').nullable().optional(),
});

export const updateInmuebleSchema = z.object({
  codigo: z
    .string()
    .min(1, 'Código requerido')
    .max(30, 'Código no puede exceder 30 caracteres')
    .regex(CODIGO_INMUEBLE_REGEX, 'Código inválido: solo letras, números, guiones, guiones bajos y espacios')
    .transform((v) => v.trim())
    .optional(),
  direccion: z.string().min(1, 'Dirección requerida').max(300, 'Dirección muy larga').optional(),
  ciudad: z.string().min(1, 'Ciudad requerida').max(100, 'Ciudad muy larga').optional(),
  barrio: z.string().max(100, 'Barrio muy largo').nullable().optional(),
  departamento: z.string().min(1, 'Departamento requerido').max(100, 'Departamento muy largo').optional(),
  tipo: z.enum(TIPOS_INMUEBLE, { error: `Tipo inválido. Valores permitidos: ${TIPOS_INMUEBLE.join(', ')}` }).optional(),
  uso: z.enum(USOS_INMUEBLE, { error: `Uso inválido. Valores permitidos: ${USOS_INMUEBLE.join(', ')}` }).optional(),
  destinacion: z.string().max(500, 'Destinacion muy larga').nullable().optional(),
  estrato: z.coerce.number().int().min(1, 'Estrato mínimo es 1').max(7, 'Estrato máximo es 7').optional(),
  valor_arriendo: z.coerce.number().positive('Valor de arriendo debe ser mayor a 0').max(999999999, 'Valor de arriendo no puede superar $999.999.999').optional(),
  valor_comercial: z.coerce.number().positive('Valor comercial debe ser mayor a 0').max(99999999999, 'Valor comercial no puede superar $99.999.999.999').nullable().optional(),
  administracion: z.coerce.number().min(0, 'Administracion no puede ser negativa').max(999999999, 'Administracion no puede superar $999.999.999').optional(),
  area_m2: z.coerce.number().positive('Área debe ser mayor a 0').max(99999, 'Área no puede superar 99.999 m²').nullable().optional(),
  habitaciones: z.coerce.number().int().min(0, 'Habitaciones no puede ser negativo').max(99, 'Máximo 99 habitaciones').optional(),
  banos: z.coerce.number().int().min(0, 'Banos no puede ser negativo').max(99, 'Máximo 99 baños').optional(),
  parqueadero: z.boolean().optional(),
  parqueaderos: z.coerce.number().int().min(0, 'Parqueaderos no puede ser negativo').max(99, 'Máximo 99 parqueaderos').nullable().optional(),
  piso: z.string().max(10, 'Piso muy largo').nullable().optional(),
  latitud: z.coerce.number().min(-90, 'Latitud inválida').max(90, 'Latitud inválida').nullable().optional(),
  longitud: z.coerce.number().min(-180, 'Longitud inválida').max(180, 'Longitud inválida').nullable().optional(),
  descripcion: z.string().max(2000, 'Descripción muy larga').nullable().optional(),
  notas_internas: z.string().max(2000, 'Notas muy largas').nullable().optional(),
  propietario_id: z.uuid({ error: 'ID de propietario inválido' }).optional(),
  visible_vitrina: z.boolean().optional(),
  foto_fachada_url: z.url({ error: 'URL de foto de fachada inválida' }).optional(),
  estado: z.enum(ESTADOS_INMUEBLE, { error: `Estado inválido. Valores permitidos: ${ESTADOS_INMUEBLE.join(', ')}` }).optional(),
  // Datos para contrato.
  propiedad_horizontal: z.boolean().nullable().optional(),
  cuarto_util: z.boolean().nullable().optional(),
  ubicacion_detallada: z.string().max(1000, 'Ubicación detallada muy larga').nullable().optional(),
});

export const listInmueblesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().optional(),
  tipo: z.enum(TIPOS_INMUEBLE).optional(),
  uso: z.enum(USOS_INMUEBLE).optional(),
  estado: z.enum(ESTADOS_INMUEBLE).optional(),
  ciudad: z.string().optional(),
  estrato: z.coerce.number().int().min(1).max(7).optional(),
  propietario_id: z.uuid().optional(),
  visible_vitrina: z.enum(['true', 'false']).optional(),
  include_inactive: z.enum(['true', 'false']).optional(),
  sortBy: z.enum(['created_at', 'valor_arriendo', 'ciudad', 'codigo', 'area_m2', 'tipo', 'estrato', 'estado']).default('created_at'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

// --- Búsqueda avanzada ---
const ESTADOS_BUSQUEDA = ['disponible', 'en_estudio', 'ocupado'] as const;
const SORT_BY_BUSQUEDA = ['rent_amount', 'created_at', 'area_m2', 'city'] as const;

export const searchInmueblesQuerySchema = z.object({
  keyword: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  property_type: z.enum(TIPOS_INMUEBLE, {
    error: `Tipo inválido. Valores permitidos: ${TIPOS_INMUEBLE.join(', ')}`,
  }).optional(),
  stratum_min: z.coerce.number().int().min(1, 'Estrato mínimo es 1').max(7, 'Estrato máximo es 7').optional(),
  stratum_max: z.coerce.number().int().min(1, 'Estrato mínimo es 1').max(7, 'Estrato máximo es 7').optional(),
  rent_min: z.coerce.number().min(0, 'Valor mínimo no puede ser negativo').optional(),
  rent_max: z.coerce.number().min(0, 'Valor máximo no puede ser negativo').optional(),
  area_min: z.coerce.number().min(0, 'Área mínima no puede ser negativa').optional(),
  area_max: z.coerce.number().min(0, 'Área máxima no puede ser negativa').optional(),
  bedrooms_min: z.coerce.number().int().min(0, 'Habitaciones no puede ser negativo').optional(),
  bathrooms_min: z.coerce.number().int().min(0, 'Banos no puede ser negativo').optional(),
  neighborhood: z.string().optional(),
  status: z.enum(ESTADOS_BUSQUEDA, {
    error: `Estado inválido. Valores permitidos: ${ESTADOS_BUSQUEDA.join(', ')}`,
  }).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.enum(SORT_BY_BUSQUEDA).default('created_at'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
}).refine(
  (data) => !(data.stratum_min && data.stratum_max && data.stratum_min > data.stratum_max),
  { error: 'El estrato mínimo no puede ser mayor al máximo', path: ['stratum_min'] },
).refine(
  (data) => !(data.rent_min && data.rent_max && data.rent_min > data.rent_max),
  { error: 'El valor mínimo de arriendo no puede ser mayor al máximo', path: ['rent_min'] },
).refine(
  (data) => !(data.area_min && data.area_max && data.area_min > data.area_max),
  { error: 'El área mínima no puede ser mayor al área máxima', path: ['area_min'] },
);

// --- Historial de cambios ---
export const listCambiosQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  campo: z.string().max(100).optional(),
  usuario_id: z.uuid({ error: 'ID de usuario inválido' }).optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export type InmuebleIdParams = z.infer<typeof inmuebleIdParamsSchema>;
export type CreateInmuebleInput = z.infer<typeof createInmuebleSchema>;
export type UpdateInmuebleInput = z.infer<typeof updateInmuebleSchema>;
export type ListInmueblesQuery = z.infer<typeof listInmueblesQuerySchema>;
export type SearchInmueblesQuery = z.infer<typeof searchInmueblesQuerySchema>;
export type ListCambiosQuery = z.infer<typeof listCambiosQuerySchema>;

// --- Visibilidad vitrina (HP-369) ---
export const visibilitySchema = z.object({
  visible_vitrina: z.boolean(),
});

export type VisibilityInput = z.infer<typeof visibilitySchema>;

// --- Asignar miembro responsable (multi-tenant Fase 3) ---
// miembro_id null = quitar la asignación.
export const asignarResponsableSchema = z.object({
  miembro_id: z.string().uuid({ message: 'ID de miembro inválido' }).nullable(),
});
export type AsignarResponsableInput = z.infer<typeof asignarResponsableSchema>;
