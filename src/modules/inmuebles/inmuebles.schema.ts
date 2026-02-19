import { z } from 'zod';

const TIPOS_INMUEBLE = ['apartamento', 'casa', 'oficina', 'local', 'bodega'] as const;
const USOS_INMUEBLE = ['vivienda', 'comercial'] as const;
const ESTADOS_INMUEBLE = ['disponible', 'en_estudio', 'ocupado', 'inactivo'] as const;

export const inmuebleIdParamsSchema = z.object({
  id: z.string().uuid('ID de inmueble invalido'),
});

export const createInmuebleSchema = z.object({
  direccion: z.string().min(1, 'Direccion requerida').max(300, 'Direccion muy larga'),
  ciudad: z.string().min(1, 'Ciudad requerida').max(100, 'Ciudad muy larga'),
  barrio: z.string().max(100, 'Barrio muy largo').optional(),
  departamento: z.string().min(1, 'Departamento requerido').max(100, 'Departamento muy largo'),
  tipo: z.enum(TIPOS_INMUEBLE, { message: `Tipo invalido. Valores permitidos: ${TIPOS_INMUEBLE.join(', ')}` }),
  uso: z.enum(USOS_INMUEBLE, { message: `Uso invalido. Valores permitidos: ${USOS_INMUEBLE.join(', ')}` }).default('vivienda'),
  destinacion: z.string().max(500, 'Destinacion muy larga').optional(),
  estrato: z.coerce.number().int().min(1, 'Estrato minimo es 1').max(6, 'Estrato maximo es 6'),
  valor_arriendo: z.coerce.number().positive('Valor de arriendo debe ser mayor a 0'),
  valor_comercial: z.coerce.number().positive('Valor comercial debe ser mayor a 0').optional(),
  administracion: z.coerce.number().min(0, 'Administracion no puede ser negativa').default(0),
  area_m2: z.coerce.number().positive('Area debe ser mayor a 0').optional(),
  habitaciones: z.coerce.number().int().min(0, 'Habitaciones no puede ser negativo').default(0),
  banos: z.coerce.number().int().min(0, 'Banos no puede ser negativo').default(0),
  parqueadero: z.boolean().default(false),
  parqueaderos: z.coerce.number().int().min(0, 'Parqueaderos no puede ser negativo').default(0),
  piso: z.string().max(10, 'Piso muy largo').optional(),
  codigo_postal: z.string().max(10, 'Codigo postal muy largo').optional(),
  latitud: z.coerce.number().min(-90, 'Latitud invalida').max(90, 'Latitud invalida').optional(),
  longitud: z.coerce.number().min(-180, 'Longitud invalida').max(180, 'Longitud invalida').optional(),
  descripcion: z.string().max(2000, 'Descripcion muy larga').optional(),
  notas_internas: z.string().max(2000, 'Notas muy largas').optional(),
  propietario_id: z.string().uuid('ID de propietario invalido'),
  visible_vitrina: z.boolean().default(false),
  foto_fachada_url: z.string().url('URL de foto de fachada invalida'),
});

export const updateInmuebleSchema = z.object({
  direccion: z.string().min(1, 'Direccion requerida').max(300, 'Direccion muy larga').optional(),
  ciudad: z.string().min(1, 'Ciudad requerida').max(100, 'Ciudad muy larga').optional(),
  barrio: z.string().max(100, 'Barrio muy largo').nullable().optional(),
  departamento: z.string().min(1, 'Departamento requerido').max(100, 'Departamento muy largo').optional(),
  tipo: z.enum(TIPOS_INMUEBLE, { message: `Tipo invalido. Valores permitidos: ${TIPOS_INMUEBLE.join(', ')}` }).optional(),
  uso: z.enum(USOS_INMUEBLE, { message: `Uso invalido. Valores permitidos: ${USOS_INMUEBLE.join(', ')}` }).optional(),
  destinacion: z.string().max(500, 'Destinacion muy larga').nullable().optional(),
  estrato: z.coerce.number().int().min(1, 'Estrato minimo es 1').max(6, 'Estrato maximo es 6').optional(),
  valor_arriendo: z.coerce.number().positive('Valor de arriendo debe ser mayor a 0').optional(),
  valor_comercial: z.coerce.number().positive('Valor comercial debe ser mayor a 0').nullable().optional(),
  administracion: z.coerce.number().min(0, 'Administracion no puede ser negativa').optional(),
  area_m2: z.coerce.number().positive('Area debe ser mayor a 0').nullable().optional(),
  habitaciones: z.coerce.number().int().min(0, 'Habitaciones no puede ser negativo').optional(),
  banos: z.coerce.number().int().min(0, 'Banos no puede ser negativo').optional(),
  parqueadero: z.boolean().optional(),
  parqueaderos: z.coerce.number().int().min(0, 'Parqueaderos no puede ser negativo').nullable().optional(),
  piso: z.string().max(10, 'Piso muy largo').nullable().optional(),
  codigo_postal: z.string().max(10, 'Codigo postal muy largo').nullable().optional(),
  latitud: z.coerce.number().min(-90, 'Latitud invalida').max(90, 'Latitud invalida').nullable().optional(),
  longitud: z.coerce.number().min(-180, 'Longitud invalida').max(180, 'Longitud invalida').nullable().optional(),
  descripcion: z.string().max(2000, 'Descripcion muy larga').nullable().optional(),
  notas_internas: z.string().max(2000, 'Notas muy largas').nullable().optional(),
  propietario_id: z.string().uuid('ID de propietario invalido').optional(),
  visible_vitrina: z.boolean().optional(),
  foto_fachada_url: z.string().url('URL de foto de fachada invalida').optional(),
  estado: z.enum(ESTADOS_INMUEBLE, { message: `Estado invalido. Valores permitidos: ${ESTADOS_INMUEBLE.join(', ')}` }).optional(),
});

export const listInmueblesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().optional(),
  tipo: z.enum(TIPOS_INMUEBLE).optional(),
  uso: z.enum(USOS_INMUEBLE).optional(),
  estado: z.enum(ESTADOS_INMUEBLE).optional(),
  ciudad: z.string().optional(),
  estrato: z.coerce.number().int().min(1).max(6).optional(),
  propietario_id: z.string().uuid().optional(),
  visible_vitrina: z.enum(['true', 'false']).optional(),
  include_inactive: z.enum(['true', 'false']).optional(),
  sortBy: z.enum(['created_at', 'valor_arriendo', 'ciudad', 'codigo', 'area_m2']).default('created_at'),
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
    message: `Tipo invalido. Valores permitidos: ${TIPOS_INMUEBLE.join(', ')}`,
  }).optional(),
  stratum_min: z.coerce.number().int().min(1, 'Estrato minimo es 1').max(6, 'Estrato maximo es 6').optional(),
  stratum_max: z.coerce.number().int().min(1, 'Estrato minimo es 1').max(6, 'Estrato maximo es 6').optional(),
  rent_min: z.coerce.number().min(0, 'Valor minimo no puede ser negativo').optional(),
  rent_max: z.coerce.number().min(0, 'Valor maximo no puede ser negativo').optional(),
  area_min: z.coerce.number().min(0, 'Area minima no puede ser negativa').optional(),
  area_max: z.coerce.number().min(0, 'Area maxima no puede ser negativa').optional(),
  bedrooms_min: z.coerce.number().int().min(0, 'Habitaciones no puede ser negativo').optional(),
  bathrooms_min: z.coerce.number().int().min(0, 'Banos no puede ser negativo').optional(),
  neighborhood: z.string().optional(),
  status: z.enum(ESTADOS_BUSQUEDA, {
    message: `Estado invalido. Valores permitidos: ${ESTADOS_BUSQUEDA.join(', ')}`,
  }).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.enum(SORT_BY_BUSQUEDA).default('created_at'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
}).refine(
  (data) => !(data.stratum_min && data.stratum_max && data.stratum_min > data.stratum_max),
  { message: 'El estrato minimo no puede ser mayor al maximo', path: ['stratum_min'] },
).refine(
  (data) => !(data.rent_min && data.rent_max && data.rent_min > data.rent_max),
  { message: 'El valor minimo de arriendo no puede ser mayor al maximo', path: ['rent_min'] },
).refine(
  (data) => !(data.area_min && data.area_max && data.area_min > data.area_max),
  { message: 'El area minima no puede ser mayor al area maxima', path: ['area_min'] },
);

// --- Historial de cambios ---
export const listCambiosQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  campo: z.string().max(100).optional(),
  usuario_id: z.string().uuid('ID de usuario invalido').optional(),
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
