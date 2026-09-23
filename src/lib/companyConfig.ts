/**
 * Datos de la empresa (Cofianza) — editables por el administrador.
 *
 * Se guardan en configuracion_sistema bajo la clave 'empresa' (JSON). Los
 * valores de src/config/company.ts quedan como DEFAULTS/fallback: getCompany()
 * mezcla el JSON guardado SOBRE los defaults, así que campos ausentes o una
 * tabla/clave inexistente caen a los defaults sin romper nada.
 *
 * Cacheado en memoria (TTL corto) para no pegarle a la BD en cada generación de
 * PDF / envío a firma. setCompany() invalida el cache.
 */

import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { COMPANY } from '@/config/company';

export interface CompanyInfo {
  name: string;
  nit: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  certificateValidityDays: number;
}

const CONFIG_KEY = 'empresa';
const CACHE_TTL_MS = 60_000;
// Si la lectura falla, el respaldo se cachea poco (igual que calibracion.ts).
const CACHE_TTL_FALLO_MS = 5_000;

const DEFAULTS: CompanyInfo = {
  name: COMPANY.name,
  nit: COMPANY.nit,
  address: COMPANY.address,
  phone: COMPANY.phone,
  email: COMPANY.email,
  website: COMPANY.website,
  certificateValidityDays: COMPANY.certificateValidityDays,
};

let cache: { value: CompanyInfo; expiresAt: number } | null = null;
// Última lectura buena: respaldo si la base falla (DEFAULTS solo si nunca se leyó).
let ultimoBueno: CompanyInfo | null = null;

const db = () => supabase.from('configuracion_sistema' as string) as ReturnType<typeof supabase.from>;

export function invalidateCompanyCache(): void {
  cache = null;
}

/** Lee la fila directo (sin caché). Lanza si la base falla. */
async function leerFila(): Promise<CompanyInfo> {
  const { data, error } = await db().select('valor').eq('clave', CONFIG_KEY).maybeSingle();
  if (error) throw new Error(error.message);
  const valor = (data as { valor: string } | null)?.valor;
  const stored = valor ? (JSON.parse(valor) as Partial<CompanyInfo>) : {};
  return { ...DEFAULTS, ...stored };
}

export async function getCompany(): Promise<CompanyInfo> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;

  try {
    const value = await leerFila();
    ultimoBueno = value;
    cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
    return value;
  } catch (e) {
    logger.warn(
      { error: e instanceof Error ? e.message : String(e) },
      'getCompany: no se pudo leer configuracion_sistema; se usa la ultima lectura buena o los defaults',
    );
    const value = ultimoBueno ?? { ...DEFAULTS };
    cache = { value, expiresAt: Date.now() + CACHE_TTL_FALLO_MS };
    return value;
  }
}

export async function setCompany(partial: Partial<CompanyInfo>): Promise<CompanyInfo> {
  // Se lee la fila, no el caché: si el caché trae los defaults por una lectura
  // fallida, el cambio parcial los guardaría encima de los datos reales.
  const current = await leerFila();
  const value: CompanyInfo = { ...current, ...partial };

  const { error } = await db().upsert(
    {
      clave: CONFIG_KEY,
      valor: JSON.stringify(value),
      tipo: 'json',
      descripcion: 'Datos de la empresa (Cofianza). Editable por el administrador.',
      updated_at: new Date().toISOString(),
    } as never,
    { onConflict: 'clave' } as never,
  );
  if (error) {
    logger.error({ error: error.message }, 'setCompany: error al guardar configuracion_sistema');
    throw error;
  }

  invalidateCompanyCache();
  ultimoBueno = value;
  return value;
}
