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
// TTL (se vence). Para la vitrina pública se firma una URL por clave y se
// reutiliza 50 de sus 60 minutos: el cliente siempre recibe una que vale al
// menos 10 min más, y la vitrina no paga un viaje a Storage por carga.
const LOGO_BUCKET = 'documentos-expedientes';
const LOGO_URL_TTL_SECONDS = 60 * 60;
const logoUrls = new Map<string, { url: string; vence: number }>();

async function urlLogo(key: string): Promise<string | null> {
  const guardada = logoUrls.get(key);
  if (guardada && guardada.vence > Date.now()) return guardada.url;
  const { data: signed } = await supabase.storage.from(LOGO_BUCKET).createSignedUrl(key, LOGO_URL_TTL_SECONDS);
  if (!signed?.signedUrl) return null;
  if (logoUrls.size > 500) logoUrls.clear();
  logoUrls.set(key, { url: signed.signedUrl, vence: Date.now() + (LOGO_URL_TTL_SECONDS - 600) * 1000 });
  return signed.signedUrl;
}

/**
 * La dueña de cada inmueble viene embebida en la misma consulta (antes eran dos
 * consultas más en serie): `inmobiliaria_id → inmobiliarias.owner_perfil_id →
 * perfiles`, el perfil canónico de la org con razón social + logo.
 */
const EMBED_INMOBILIARIA =
  'org:inmobiliarias!inmuebles_inmobiliaria_id_fkey(owner:perfiles!inmobiliarias_owner_perfil_id_fkey(razon_social, nombre, apellido, logo_storage_key))';

type OrgEmbebida = {
  owner: { razon_social: string | null; nombre: string | null; apellido: string | null; logo_storage_key: string | null } | null;
} | null;

/**
 * Identidad PÚBLICA (nombre comercial + logo) de la inmobiliaria dueña de cada
 * inmueble, a partir del embed. NO expone propietario_id, inmobiliaria_id ni el
 * embed (se eliminan del objeto devuelto). Los inmuebles de propietario
 * individual quedan con `inmobiliaria: null`.
 */
async function attachInmobiliarias(
  rows: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  const owners = rows.map((r) => (r.org as OrgEmbebida)?.owner ?? null);
  const keys = [...new Set(owners.map((o) => o?.logo_storage_key).filter((x): x is string => typeof x === 'string'))];
  const urlPorKey = new Map(await Promise.all(keys.map(async (k) => [k, await urlLogo(k)] as const)));

  return rows.map((row, i) => {
    const rest = { ...row };
    delete rest.inmobiliaria_id;
    delete rest.org;
    const owner = owners[i];
    const nombre = owner
      ? owner.razon_social?.trim() || `${owner.nombre ?? ''} ${owner.apellido ?? ''}`.trim() || null
      : null;
    const logo_url = owner?.logo_storage_key ? urlPorKey.get(owner.logo_storage_key) ?? null : null;
    // Solo exponemos el bloque si hay algo que mostrar (nombre o logo).
    return { ...rest, inmobiliaria: nombre || logo_url ? { nombre, logo_url } : null };
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
    .select(`${PUBLIC_FIELDS}, inmobiliaria_id, ${EMBED_INMOBILIARIA}`, { count: 'exact' });

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
    .select(`${PUBLIC_DETAIL_FIELDS}, inmobiliaria_id, ${EMBED_INMOBILIARIA}`);

  qb = applyPublicConditions(qb);

  // El inmueble y sus fotos a la vez; si el inmueble no es público, las fotos
  // leídas se descartan con el 404.
  // Fotos: primero la de fachada (es_fachada DESC) y después el orden manual.
  // Sin este sort, el frontend caia a comparar URLs para reordenar — fragil
  // con signed URLs que tienen timestamps cambiantes.
  const [{ data, error }, { data: fotos }] = await Promise.all([
    qb.eq('id', id).single(),
    supabase
      .from('fotos_inmueble')
      .select('id, url, descripcion, orden, es_fachada')
      .eq('inmueble_id', id)
      .order('es_fachada', { ascending: false })
      .order('orden', { ascending: true }),
  ]);

  if (error) {
    if (error.code === 'PGRST116') {
      throw AppError.notFound('Inmueble no encontrado o no disponible');
    }
    throw fromSupabaseError(error);
  }

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
