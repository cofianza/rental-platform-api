/**
 * Catalogo de municipios de Colombia (DIVIPOLA / codigos DANE).
 *
 * Factus expone los municipios como "tabla de referencia" en su
 * documentacion pero NO via API (/v2/municipalities devuelve 404).
 * Como Factus si exige el codigo DANE de 5 digitos al crear facturas,
 * mantenemos nosotros el catalogo y lo usamos para autocomplete.
 *
 * Fuente: dataset DIVIPOLA del DANE expuesto via Socrata en
 * datos.gov.co/resource/gdxc-w37w.json. ~1.123 municipios.
 *
 * Estrategia: fetch on-demand + cache 24h en memoria. Fallback a un
 * subset minimo embedido si el endpoint publico esta caido.
 */

import { logger } from '@/lib/logger';

export interface MunicipioCO {
  /** Codigo DANE de 5 digitos (string para preservar ceros a la izquierda). */
  code: string;
  /** Nombre del municipio (ej. "Medellin"). */
  name: string;
  department: {
    /** Codigo DANE del departamento (2 digitos). */
    code: string;
    /** Nombre del departamento (ej. "Antioquia"). */
    name: string;
  };
}

const DATOS_GOV_URL = 'https://www.datos.gov.co/resource/gdxc-w37w.json?$limit=2000';

/** Subset de los principales municipios — usado solo si el fetch falla. */
const FALLBACK_MUNICIPIOS: MunicipioCO[] = [
  { code: '11001', name: 'Bogota D.C.', department: { code: '11', name: 'Bogota D.C.' } },
  { code: '05001', name: 'Medellin', department: { code: '05', name: 'Antioquia' } },
  { code: '05088', name: 'Bello', department: { code: '05', name: 'Antioquia' } },
  { code: '05266', name: 'Envigado', department: { code: '05', name: 'Antioquia' } },
  { code: '05360', name: 'Itagui', department: { code: '05', name: 'Antioquia' } },
  { code: '05631', name: 'Sabaneta', department: { code: '05', name: 'Antioquia' } },
  { code: '05129', name: 'Caldas', department: { code: '05', name: 'Antioquia' } },
  { code: '05380', name: 'La Estrella', department: { code: '05', name: 'Antioquia' } },
  { code: '76001', name: 'Cali', department: { code: '76', name: 'Valle del Cauca' } },
  { code: '08001', name: 'Barranquilla', department: { code: '08', name: 'Atlantico' } },
  { code: '13001', name: 'Cartagena de Indias', department: { code: '13', name: 'Bolivar' } },
  { code: '54001', name: 'Cucuta', department: { code: '54', name: 'Norte de Santander' } },
  { code: '68001', name: 'Bucaramanga', department: { code: '68', name: 'Santander' } },
  { code: '17001', name: 'Manizales', department: { code: '17', name: 'Caldas' } },
  { code: '66001', name: 'Pereira', department: { code: '66', name: 'Risaralda' } },
  { code: '63001', name: 'Armenia', department: { code: '63', name: 'Quindio' } },
  { code: '41001', name: 'Neiva', department: { code: '41', name: 'Huila' } },
  { code: '73001', name: 'Ibague', department: { code: '73', name: 'Tolima' } },
  { code: '20001', name: 'Valledupar', department: { code: '20', name: 'Cesar' } },
  { code: '23001', name: 'Monteria', department: { code: '23', name: 'Cordoba' } },
  { code: '50001', name: 'Villavicencio', department: { code: '50', name: 'Meta' } },
  { code: '47001', name: 'Santa Marta', department: { code: '47', name: 'Magdalena' } },
  { code: '52001', name: 'Pasto', department: { code: '52', name: 'Narino' } },
  { code: '15001', name: 'Tunja', department: { code: '15', name: 'Boyaca' } },
  { code: '19001', name: 'Popayan', department: { code: '19', name: 'Cauca' } },
  { code: '70001', name: 'Sincelejo', department: { code: '70', name: 'Sucre' } },
  { code: '44001', name: 'Riohacha', department: { code: '44', name: 'La Guajira' } },
  { code: '25754', name: 'Soacha', department: { code: '25', name: 'Cundinamarca' } },
  { code: '25175', name: 'Chia', department: { code: '25', name: 'Cundinamarca' } },
  { code: '25899', name: 'Zipaquira', department: { code: '25', name: 'Cundinamarca' } },
];

interface RawDanePoint {
  cod_dpto?: string;
  dpto?: string;
  cod_mpio?: string;
  nom_mpio?: string;
  // El dataset puede usar otros nombres en distintas vistas.
  c_digo_dane_del_municipio?: string;
  municipio?: string;
}

let cache: { data: MunicipioCO[]; cachedAt: number } | null = null;
let inflight: Promise<MunicipioCO[]> | null = null;
const TTL_MS = 24 * 60 * 60 * 1000;

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(' ')
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function normalize(s: string): string {
  // U+0300 a U+036F = "Combining Diacritical Marks" (tildes, dieresis, etc).
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

async function fetchFromDatosGov(): Promise<MunicipioCO[]> {
  const res = await fetch(DATOS_GOV_URL, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`datos.gov.co status ${res.status}`);
  }
  const rows = (await res.json()) as RawDanePoint[];
  if (!Array.isArray(rows)) {
    throw new Error('datos.gov.co: respuesta inesperada (no es array)');
  }

  const out: MunicipioCO[] = [];
  for (const row of rows) {
    const code = row.cod_mpio || row.c_digo_dane_del_municipio || '';
    const name = row.nom_mpio || row.municipio || '';
    const deptCode = row.cod_dpto || '';
    const deptName = row.dpto || '';
    if (!code || !name || code.length < 5) continue;
    out.push({
      code,
      name: titleCase(name),
      department: {
        code: deptCode.padStart(2, '0'),
        name: titleCase(deptName),
      },
    });
  }
  return out;
}

async function getCatalog(): Promise<MunicipioCO[]> {
  const now = Date.now();
  if (cache && now - cache.cachedAt < TTL_MS) {
    return cache.data;
  }
  if (inflight) return inflight;

  inflight = fetchFromDatosGov()
    .then((list) => {
      if (list.length < 50) {
        logger.warn(
          { count: list.length },
          'Catalogo DIVIPOLA: muy pocos resultados, usando fallback embebido',
        );
        const merged = mergeUnique(list, FALLBACK_MUNICIPIOS);
        cache = { data: merged, cachedAt: Date.now() };
        return merged;
      }
      cache = { data: list, cachedAt: Date.now() };
      logger.info({ count: list.length }, 'Catalogo DIVIPOLA cargado');
      return list;
    })
    .catch((err) => {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'Error cargando DIVIPOLA — usando fallback embebido',
      );
      // No cacheamos el fallback (queremos reintentar en la siguiente request).
      return FALLBACK_MUNICIPIOS;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

function mergeUnique(a: MunicipioCO[], b: MunicipioCO[]): MunicipioCO[] {
  const byCode = new Map<string, MunicipioCO>();
  for (const m of a) byCode.set(m.code, m);
  for (const m of b) if (!byCode.has(m.code)) byCode.set(m.code, m);
  return Array.from(byCode.values());
}

/**
 * Busca municipios por nombre (o nombre de departamento). Comparacion sin
 * tildes y case-insensitive. Hasta 50 resultados.
 */
export async function searchMunicipios(query: string): Promise<MunicipioCO[]> {
  const all = await getCatalog();
  const needle = normalize(query.trim());
  if (!needle) return [];

  const matches = all.filter(
    (m) => normalize(m.name).includes(needle) || normalize(m.department.name).includes(needle),
  );
  // Priorizar coincidencias que empiezan por el query.
  matches.sort((a, b) => {
    const aStarts = normalize(a.name).startsWith(needle) ? 0 : 1;
    const bStarts = normalize(b.name).startsWith(needle) ? 0 : 1;
    return aStarts - bStarts || a.name.localeCompare(b.name);
  });
  return matches.slice(0, 50);
}

/**
 * Lookup por codigo DANE de 5 digitos. Util para validar al guardar.
 */
export async function findMunicipioByCode(code: string): Promise<MunicipioCO | null> {
  const all = await getCatalog();
  return all.find((m) => m.code === code) || null;
}
