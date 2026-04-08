// ============================================================
// Public Properties — Service (HP-365)
// Only exposes safe, public fields. NEVER returns address,
// owner data, or internal notes.
// ============================================================

import { supabase } from '@/lib/supabase';
import { AppError, fromSupabaseError } from '@/lib/errors';
import { buildPaginationMeta } from '@/utils/pagination';
import type { ListPublicPropertiesQuery } from './public-properties.schema';

// ── Public-safe fields (NEVER include direccion, propietario_id, notas_internas) ──

const PUBLIC_FIELDS = `
  id,
  tipo,
  ciudad,
  barrio,
  estrato,
  area_m2,
  habitaciones,
  banos,
  parqueadero,
  parqueaderos,
  valor_arriendo,
  administracion,
  descripcion,
  foto_fachada_url,
  created_at
`;

// Detail includes a few more public fields
const PUBLIC_DETAIL_FIELDS = `
  ${PUBLIC_FIELDS},
  uso,
  piso,
  codigo_postal,
  latitud,
  longitud
`;

// ── Types ───────────────────────────────────────────────────

export interface PublicProperty {
  id: string;
  tipo: string;
  ciudad: string;
  barrio: string | null;
  estrato: number;
  area_m2: number | null;
  habitaciones: number;
  banos: number;
  parqueadero: boolean;
  parqueaderos: number;
  valor_arriendo: number;
  administracion: number;
  descripcion: string | null;
  foto_fachada_url: string | null;
  fotos?: PublicPropertyPhoto[];
  created_at: string;
}

export interface PublicPropertyPhoto {
  id: string;
  url: string;
  descripcion: string | null;
  orden: number;
}

export interface PublicPropertyFilters {
  ciudades: string[];
  tipos: string[];
  estratos: number[];
}

// ── Base query conditions (visible_vitrina=true AND estado=disponible) ──

function applyPublicConditions(qb: ReturnType<typeof supabase.from>) {
  return qb
    .eq('visible_vitrina', true)
    .eq('estado', 'disponible');
}

// ── Service Functions ───────────────────────────────────────

export async function listPublicProperties(query: ListPublicPropertiesQuery) {
  const {
    page, limit, ciudad, tipo, estrato,
    precio_min, precio_max, habitaciones,
    search, sortBy, sortOrder,
  } = query;

  const offset = (page - 1) * limit;

  let qb = supabase
    .from('inmuebles')
    .select(PUBLIC_FIELDS, { count: 'exact' });

  // Always apply public conditions
  qb = applyPublicConditions(qb);

  // Filters
  if (ciudad) {
    qb = qb.ilike('ciudad', ciudad);
  }
  if (tipo) {
    qb = qb.eq('tipo', tipo.toLowerCase());
  }
  if (estrato) {
    qb = qb.eq('estrato', estrato);
  }
  if (precio_min !== undefined) {
    qb = qb.gte('valor_arriendo', precio_min);
  }
  if (precio_max !== undefined) {
    qb = qb.lte('valor_arriendo', precio_max);
  }
  if (habitaciones !== undefined) {
    qb = qb.gte('habitaciones', habitaciones);
  }

  // Text search (case insensitive across barrio, ciudad, tipo, descripcion)
  if (search) {
    qb = qb.or(
      `barrio.ilike.%${search}%,ciudad.ilike.%${search}%,tipo.ilike.%${search}%,descripcion.ilike.%${search}%`,
    );
  }

  // Sort and paginate
  qb = qb
    .order(sortBy, { ascending: sortOrder === 'asc' })
    .range(offset, offset + limit - 1);

  const { data, error, count } = await qb;

  if (error) throw fromSupabaseError(error);

  const total = count ?? 0;
  const pagination = buildPaginationMeta(total, page, limit);

  return { data: data ?? [], pagination };
}

export async function getPublicPropertyById(id: string) {
  // Fetch the property with public fields only
  let qb = supabase
    .from('inmuebles')
    .select(PUBLIC_DETAIL_FIELDS);

  qb = applyPublicConditions(qb);

  const { data, error } = await qb.eq('id', id).single();

  if (error) {
    if (error.code === 'PGRST116') {
      throw AppError.notFound('Inmueble no encontrado o no disponible');
    }
    throw fromSupabaseError(error);
  }

  // Fetch photos for this property
  const { data: fotos } = await supabase
    .from('fotos_inmueble')
    .select('id, url, descripcion, orden')
    .eq('inmueble_id', id)
    .order('orden', { ascending: true });

  const result = data as Record<string, unknown>;
  return {
    ...result,
    fotos: fotos ?? [],
  };
}

export async function getPublicPropertyFilters(): Promise<PublicPropertyFilters> {
  // Fetch all public + available properties to compute unique filter values
  let qb = supabase
    .from('inmuebles')
    .select('ciudad, tipo, estrato');

  qb = applyPublicConditions(qb);

  const { data, error } = await qb;

  if (error) throw fromSupabaseError(error);

  if (!data || data.length === 0) {
    return { ciudades: [], tipos: [], estratos: [] };
  }

  const ciudadesSet = new Set<string>();
  const tiposSet = new Set<string>();
  const estratosSet = new Set<number>();

  for (const row of data) {
    const r = row as { ciudad: string; tipo: string; estrato: number };
    if (r.ciudad) ciudadesSet.add(r.ciudad);
    if (r.tipo) tiposSet.add(r.tipo);
    if (r.estrato) estratosSet.add(r.estrato);
  }

  return {
    ciudades: Array.from(ciudadesSet).sort(),
    tipos: Array.from(tiposSet).sort(),
    estratos: Array.from(estratosSet).sort((a, b) => a - b),
  };
}
