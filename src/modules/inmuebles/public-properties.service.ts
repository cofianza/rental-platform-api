// ============================================================
// Public Properties — Service (HP-365)
// Only exposes safe, public fields. NEVER returns address,
// owner data, or internal notes.
// ============================================================

import { supabase } from '@/lib/supabase';
import { AppError, fromSupabaseError } from '@/lib/errors';
import { logger } from '@/lib/logger';
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
  // Identidad PÚBLICA de la inmobiliaria dueña (nombre comercial + logo).
  // null para propietarios individuales o si no hay nada que mostrar.
  inmobiliaria?: InmobiliariaPublica | null;
}

export interface PublicPropertyPhoto {
  id: string;
  url: string;
  descripcion: string | null;
  orden: number;
}

export interface InmobiliariaPublica {
  nombre: string | null;
  logo_url: string | null;
}

export interface PublicPropertyFilters {
  ciudades: string[];
  tipos: string[];
  estratos: number[];
}

// El logo vive en un bucket PRIVADO; el logo_url guardado es una URL firmada con
// TTL (se vence). Para la vitrina pública generamos una URL firmada FRESCA por
// request (la vitrina se sirve no-store, así que se regenera en cada carga).
const LOGO_BUCKET = 'documentos-expedientes';
const LOGO_URL_TTL_SECONDS = 60 * 60;

const db = (table: string) => supabase.from(table as string) as ReturnType<typeof supabase.from>;

/**
 * Resuelve la identidad PÚBLICA (nombre comercial + logo) de la inmobiliaria
 * dueña de cada inmueble, vía `inmobiliaria_id → inmobiliarias.owner_perfil_id →
 * perfiles` (el perfil canónico de la org, que tiene razón social + logo). NO
 * expone propietario_id ni inmobiliaria_id (se eliminan del objeto devuelto).
 * Los inmuebles de propietario individual quedan con `inmobiliaria: null`.
 */
async function attachInmobiliarias(
  rows: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  const ids = [
    ...new Set(rows.map((r) => r.inmobiliaria_id).filter((x): x is string => typeof x === 'string')),
  ];
  const byInmoId = new Map<string, InmobiliariaPublica>();

  if (ids.length > 0) {
    const { data: orgs } = await db('inmobiliarias').select('id, owner_perfil_id').in('id', ids);
    const orgRows = (orgs ?? []) as Array<{ id: string; owner_perfil_id: string | null }>;
    const ownerIds = [
      ...new Set(orgRows.map((o) => o.owner_perfil_id).filter((x): x is string => typeof x === 'string')),
    ];

    const ownerById = new Map<
      string,
      { razon_social: string | null; nombre: string | null; apellido: string | null; logo_storage_key: string | null }
    >();
    if (ownerIds.length > 0) {
      const { data: perfiles } = await db('perfiles')
        .select('id, razon_social, nombre, apellido, logo_storage_key')
        .in('id', ownerIds);
      for (const p of (perfiles ?? []) as Array<{
        id: string; razon_social: string | null; nombre: string | null; apellido: string | null; logo_storage_key: string | null;
      }>) {
        ownerById.set(p.id, p);
      }
    }

    // URL firmada fresca por cada logo distinto (en paralelo).
    const keys = [
      ...new Set(
        [...ownerById.values()].map((p) => p.logo_storage_key).filter((x): x is string => typeof x === 'string'),
      ),
    ];
    const signedByKey = new Map<string, string>();
    await Promise.all(
      keys.map(async (key) => {
        const { data: signed } = await supabase.storage.from(LOGO_BUCKET).createSignedUrl(key, LOGO_URL_TTL_SECONDS);
        if (signed?.signedUrl) signedByKey.set(key, signed.signedUrl);
      }),
    );

    for (const o of orgRows) {
      const owner = o.owner_perfil_id ? ownerById.get(o.owner_perfil_id) : undefined;
      if (!owner) continue;
      const nombre =
        owner.razon_social?.trim() || `${owner.nombre ?? ''} ${owner.apellido ?? ''}`.trim() || null;
      const logo_url = owner.logo_storage_key ? signedByKey.get(owner.logo_storage_key) ?? null : null;
      byInmoId.set(o.id, { nombre, logo_url });
    }
  }

  return rows.map((row) => {
    const { inmobiliaria_id, ...rest } = row as Record<string, unknown> & { inmobiliaria_id?: string | null };
    const inmo = typeof inmobiliaria_id === 'string' ? byInmoId.get(inmobiliaria_id) ?? null : null;
    // Solo exponemos el bloque si hay algo que mostrar (nombre o logo).
    const inmobiliaria = inmo && (inmo.nombre || inmo.logo_url) ? inmo : null;
    return { ...rest, inmobiliaria };
  });
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
    .select(`${PUBLIC_FIELDS}, inmobiliaria_id`, { count: 'exact' });

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

  const withInmo = await attachInmobiliarias((data ?? []) as Array<Record<string, unknown>>);
  return { data: withInmo, pagination };
}

export async function getPublicPropertyById(id: string) {
  // Fetch the property with public fields only
  let qb = supabase
    .from('inmuebles')
    .select(`${PUBLIC_DETAIL_FIELDS}, inmobiliaria_id`);

  qb = applyPublicConditions(qb);

  const { data, error } = await qb.eq('id', id).single();

  if (error) {
    if (error.code === 'PGRST116') {
      throw AppError.notFound('Inmueble no encontrado o no disponible');
    }
    throw fromSupabaseError(error);
  }

  // Fetch photos for this property. Ordenamos primero por es_fachada DESC
  // para que la foto marcada como fachada siempre aparezca en posicion 1
  // (independientemente de su 'orden'), y como tiebreaker el orden manual.
  // Sin este sort, el frontend caia a comparar URLs para reordenar — fragil
  // con signed URLs que tienen timestamps cambiantes.
  const { data: fotos } = await supabase
    .from('fotos_inmueble')
    .select('id, url, descripcion, orden, es_fachada')
    .eq('inmueble_id', id)
    .order('es_fachada', { ascending: false })
    .order('orden', { ascending: true });

  const [withInmo] = await attachInmobiliarias([data as Record<string, unknown>]);
  return {
    ...withInmo,
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

// ── Vitrina: tracking de visitas (analytics) ────────────────
//
// Se ejecuta best-effort. Si el insert falla (BD intermitente, inmueble
// inexistente, etc.) lo logueamos pero NO propagamos el error: el endpoint
// es público y analítico, y romperlo perjudica la experiencia del visitante.

export async function trackVitrinaVisit(
  inmuebleId: string,
  meta: { ip: string | null; userAgent: string | null; referrer: string | null },
): Promise<void> {
  try {
    const { error } = await (
      supabase.from('vitrina_interacciones' as string) as ReturnType<typeof supabase.from>
    ).insert({
      inmueble_id: inmuebleId,
      tipo: 'vista',
      ip: meta.ip ? meta.ip.slice(0, 45) : null,
      user_agent: meta.userAgent ? meta.userAgent.slice(0, 500) : null,
      referrer: meta.referrer ? meta.referrer.slice(0, 500) : null,
    });

    if (error) {
      logger.warn({ err: error.message, inmuebleId }, 'No se pudo registrar visita a vitrina');
    }
  } catch (err) {
    logger.warn({ err, inmuebleId }, 'Error inesperado al registrar visita a vitrina');
  }
}
