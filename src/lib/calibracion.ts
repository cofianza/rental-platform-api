/**
 * Parametros de calibracion del modelo — Adenda 1 a la Politica V4.1, §11.
 *
 * "Todos estos valores deben poder modificarse desde el panel de calibracion,
 * sin intervencion de desarrollo, unicamente por la Gerencia General, y todo
 * cambio debe quedar registrado con fecha, valor anterior, valor nuevo y
 * usuario."
 *
 * Mismo patron que companyConfig.ts: los DEFAULTS viven aqui, la tabla
 * `parametros_calibracion` los sobrescribe, y una tabla o clave inexistente
 * cae al default sin romper nada. Cache en memoria con TTL corto: los
 * parametros se leen en cada evaluacion y no puede costar un roundtrip.
 *
 * LOS CONSUMIDORES SON PUROS. El motor, las rutas, la expiracion y las tarifas
 * reciben los numeros por parametro; este modulo es el UNICO que habla con la
 * tabla. Asi los scripts/check-* siguen corriendo sin Supabase.
 */

import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { AppError } from '@/lib/errors';
import { env } from '@/config';

export type ClaveCalibracion =
  | 'FACTOR_AJUSTE_INGRESO'
  | 'UMBRAL_CASCADA_RECHAZO'
  | 'UMBRAL_CASCADA_APROBACION'
  | 'UMBRAL_DIFERENCIA_INGRESO'
  | 'VIGENCIA_CRC_DIAS'
  | 'DIAS_EXPIRACION_ESTUDIO'
  | 'UMBRAL_COARRENDATARIO'
  | 'CANON_MAX_TRANSITORIO'
  | 'UMBRAL_APROBACION_AUTOMATICA'
  | 'UMBRAL_ZONA_GRIS';

export type Calibracion = Record<ClaveCalibracion, number>;

export interface DefinicionParametro {
  clave: ClaveCalibracion;
  valorDefault: number;
  /** Rango admisible. Un valor fuera de rango se rechaza en setParametro. */
  min: number;
  max: number;
  /** true = solo enteros. */
  entero: boolean;
  seccion: string;
  descripcion: string;
  /** Lo que la Adenda pide dejar registrado al lado del valor. */
  advertencia?: string;
}

/**
 * Los valores iniciales son los de la Adenda §11, salvo CANON_MAX_TRANSITORIO,
 * que se siembra con lo que ya corre en produccion (env, Flujo §4.4: 3.000.000)
 * porque la Adenda remite a la Politica (§6: 2.000.000) sin resolver la
 * contradiccion entre los dos documentos. Gerencia lo mueve desde el panel.
 */
export const PARAMETROS: readonly DefinicionParametro[] = [
  {
    clave: 'FACTOR_AJUSTE_INGRESO',
    valorDefault: 1.15,
    min: 1,
    max: 2,
    entero: false,
    seccion: 'Adenda §1.1',
    descripcion: 'Multiplica el ingreso estimado por la central antes de calcular DTI y canon/ingreso.',
    advertencia:
      'Amplia de hecho las reglas duras: con 1,15 el canon maximo del 40% admite hasta el 46% del ingreso real, y el DTI del 65% hasta el 74,7%. Decision deliberada de apetito de riesgo de la Gerencia General.',
  },
  {
    clave: 'UMBRAL_CASCADA_RECHAZO',
    valorDefault: 40,
    min: 0,
    max: 100,
    entero: true,
    seccion: 'Adenda §2.1',
    descripcion: 'Puntaje de la central primaria por debajo del cual se rechaza sin consultar la segunda.',
  },
  {
    clave: 'UMBRAL_CASCADA_APROBACION',
    valorDefault: 90,
    min: 0,
    max: 100,
    entero: true,
    seccion: 'Adenda §2.1',
    descripcion: 'Puntaje de la central primaria desde el cual se aprueba sin consultar la segunda.',
    advertencia:
      'Es una asuncion de riesgo, no una certeza matematica: un 90 en Datacredito podria tener 60 en TransUnion. Monitorear los primeros seis meses con una muestra consultada a posteriori.',
  },
  {
    clave: 'UMBRAL_DIFERENCIA_INGRESO',
    valorDefault: 50,
    min: 0,
    max: 500,
    entero: false,
    seccion: 'Adenda §8',
    descripcion: 'Diferencia (%) entre ingreso declarado y estimado que levanta bandera de revision manual. No rechaza.',
  },
  {
    clave: 'VIGENCIA_CRC_DIAS',
    valorDefault: 60,
    min: 1,
    max: 365,
    entero: true,
    seccion: 'Adenda §6',
    descripcion: 'Vigencia del CRC en dias calendario desde la fecha de evaluacion.',
  },
  {
    clave: 'DIAS_EXPIRACION_ESTUDIO',
    valorDefault: 15,
    min: 1,
    max: 90,
    entero: true,
    seccion: 'Adenda §9',
    descripcion: 'Dias desde el envio de la solicitud al prospecto para que el estudio expire sin autorizar.',
  },
  {
    clave: 'UMBRAL_COARRENDATARIO',
    valorDefault: 80,
    min: 0,
    max: 100,
    entero: true,
    seccion: 'Adenda §3',
    descripcion: 'Puntaje minimo del COARRENDATARIO para aprobar automaticamente a un titular en zona gris (70-84).',
  },
  {
    clave: 'CANON_MAX_TRANSITORIO',
    valorDefault: env.CANON_MAXIMO_SIN_COAFIANZAMIENTO_COP,
    min: 100_000,
    max: 100_000_000,
    entero: true,
    seccion: 'Politica §6 / Flujo §4.4',
    descripcion: 'Canon maximo sin coafianzamiento (COP). Se deroga al entrar en vigencia el coafianzamiento.',
    advertencia: 'La Politica §6 dice 2.000.000 y el Flujo §4.4 dice 3.000.000. Gerencia (Mario, 2026-09-09) resolvio 3.000.000; falta actualizar el texto del §6.',
  },
  {
    clave: 'UMBRAL_APROBACION_AUTOMATICA',
    valorDefault: 85,
    min: 0,
    max: 100,
    entero: true,
    seccion: 'Politica §3.1',
    descripcion: 'Puntaje normalizado desde el cual se aprueba automaticamente (firma solo).',
  },
  {
    clave: 'UMBRAL_ZONA_GRIS',
    valorDefault: 70,
    min: 0,
    max: 100,
    entero: true,
    seccion: 'Politica §3.1',
    descripcion: 'Puntaje normalizado desde el cual empieza la zona gris (hasta el umbral de aprobacion). Por debajo, rechazo.',
  },
];

export const CALIBRACION_DEFAULT: Calibracion = Object.fromEntries(
  PARAMETROS.map((p) => [p.clave, p.valorDefault]),
) as Calibracion;

const CACHE_TTL_MS = 60_000;
let cache: { value: Calibracion; expiresAt: number } | null = null;

const db = (tabla: string) => supabase.from(tabla as string) as ReturnType<typeof supabase.from>;

export function invalidateCalibracionCache(): void {
  cache = null;
}

/** Pura: valida un valor contra su definicion. Devuelve el motivo del rechazo o null. */
export function validarParametro(clave: string, valor: unknown): { def: DefinicionParametro; error: string | null } | null {
  const def = PARAMETROS.find((p) => p.clave === clave);
  if (!def) return null;
  if (typeof valor !== 'number' || !Number.isFinite(valor)) return { def, error: 'El valor debe ser numerico' };
  if (def.entero && !Number.isInteger(valor)) return { def, error: 'El valor debe ser entero' };
  if (valor < def.min || valor > def.max) return { def, error: `Fuera de rango (${def.min} a ${def.max})` };
  return { def, error: null };
}

/**
 * Parametros vigentes: defaults + lo guardado. Nunca lanza.
 */
export async function getCalibracion(): Promise<Calibracion> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;

  const value: Calibracion = { ...CALIBRACION_DEFAULT };
  try {
    const { data, error } = await db('parametros_calibracion').select('clave, valor');
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as Array<{ clave: string; valor: number | string }>) {
      const n = typeof row.valor === 'string' ? Number(row.valor) : row.valor;
      const v = validarParametro(row.clave, n);
      if (v && !v.error) value[row.clave as ClaveCalibracion] = n;
      else if (v) logger.warn({ clave: row.clave, valor: row.valor, error: v.error }, 'Calibracion: valor guardado invalido — se usa el default');
    }
  } catch (e) {
    logger.warn(
      { error: e instanceof Error ? e.message : String(e) },
      'getCalibracion: no se pudo leer parametros_calibracion; usando defaults',
    );
  }

  cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

export interface FilaParametro extends DefinicionParametro {
  valor: number;
  actualizado_en: string | null;
  actualizado_por: string | null;
}

/** Para el panel: definicion + valor vigente + quien lo toco. */
export async function listarParametros(): Promise<FilaParametro[]> {
  const vigente = await getCalibracion();
  let meta: Record<string, { actualizado_en: string | null; actualizado_por: string | null }> = {};
  try {
    const { data } = await db('parametros_calibracion').select('clave, actualizado_en, actualizado_por');
    for (const r of (data ?? []) as Array<{ clave: string; actualizado_en: string | null; actualizado_por: string | null }>) {
      meta[r.clave] = { actualizado_en: r.actualizado_en, actualizado_por: r.actualizado_por };
    }
  } catch {
    meta = {};
  }
  return PARAMETROS.map((p) => ({
    ...p,
    valor: vigente[p.clave],
    actualizado_en: meta[p.clave]?.actualizado_en ?? null,
    actualizado_por: meta[p.clave]?.actualizado_por ?? null,
  }));
}

/**
 * Cambia un parametro dejando el rastro que exige la Adenda §11 (fecha, valor
 * anterior, valor nuevo, usuario). Lanza si la clave no existe o el valor esta
 * fuera de rango — aqui SI se lanza: es una escritura de Gerencia, no un
 * camino caliente.
 */
export async function setParametro(
  clave: string,
  valor: number,
  usuarioId: string,
  motivo?: string,
): Promise<FilaParametro> {
  const v = validarParametro(clave, valor);
  if (!v) throw new Error(`Parametro desconocido: ${clave}`);
  if (v.error) throw new Error(`${clave}: ${v.error}`);

  const anterior = (await getCalibracion())[clave as ClaveCalibracion];
  const ahora = new Date().toISOString();

  // SIN HISTORIAL NO HAY CAMBIO. La Adenda §11 exige el rastro de cada cambio;
  // antes el valor se escribia primero y, si el historial fallaba, quedaba un
  // cambio vigente sin rastro (solo un log). Ahora el rastro va PRIMERO: si no
  // se puede escribir, el valor no se toca. No hay transaccion (dos tablas por
  // PostgREST), asi que el orden es la garantia.
  const { data: hist, error: histError } = await db('parametros_calibracion_historial')
    .insert({
      clave,
      valor_anterior: anterior,
      valor_nuevo: valor,
      usuario_id: usuarioId,
      motivo: motivo ?? null,
    } as never)
    .select('id')
    .single();
  if (histError || !hist) {
    logger.error({ clave, error: histError?.message ?? 'sin fila' }, 'Calibracion: no se pudo registrar el historial — el valor NO se cambio');
    throw new AppError(
      500,
      'CALIBRACION_HISTORIAL_ERROR',
      `No se pudo registrar el historial del cambio de ${clave}; el valor no se modifico. ${histError?.message ?? ''}`.trim(),
    );
  }
  const histId = (hist as { id?: string }).id;

  const { error } = await db('parametros_calibracion').upsert(
    {
      clave,
      valor,
      descripcion: v.def.descripcion,
      actualizado_en: ahora,
      actualizado_por: usuarioId,
    } as never,
    { onConflict: 'clave' } as never,
  );
  if (error) {
    // El valor no cambio: se retira el rastro recien escrito (best-effort) para
    // que el historial no cuente un cambio que nunca ocurrio.
    if (histId) {
      const { error: delError } = await db('parametros_calibracion_historial').delete().eq('id', histId);
      if (delError) {
        logger.error({ clave, histId, error: delError.message }, 'Calibracion: el valor NO cambio pero quedo una fila de historial huerfana');
      }
    }
    throw new AppError(500, 'CALIBRACION_GUARDAR_ERROR', `No se pudo guardar ${clave}: ${error.message}`);
  }

  invalidateCalibracionCache();
  logger.info({ clave, anterior, nuevo: valor, usuarioId, motivo }, 'Calibracion: parametro actualizado');

  return {
    ...v.def,
    valor,
    actualizado_en: ahora,
    actualizado_por: usuarioId,
  };
}

export interface EntradaHistorial {
  id: string;
  clave: string;
  valor_anterior: number | null;
  valor_nuevo: number;
  usuario_id: string | null;
  usuario_nombre: string | null;
  motivo: string | null;
  created_at: string;
}

export async function listarHistorial(limit = 100): Promise<EntradaHistorial[]> {
  const { data, error } = await db('parametros_calibracion_historial')
    .select('id, clave, valor_anterior, valor_nuevo, usuario_id, motivo, created_at, perfiles(nombre, apellido)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    logger.warn({ error: error.message }, 'Calibracion: no se pudo leer el historial');
    return [];
  }
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
    const p = r.perfiles as { nombre?: string; apellido?: string } | null;
    return {
      id: String(r.id),
      clave: String(r.clave),
      valor_anterior: r.valor_anterior == null ? null : Number(r.valor_anterior),
      valor_nuevo: Number(r.valor_nuevo),
      usuario_id: (r.usuario_id as string | null) ?? null,
      usuario_nombre: p ? `${p.nombre ?? ''} ${p.apellido ?? ''}`.trim() || null : null,
      motivo: (r.motivo as string | null) ?? null,
      created_at: String(r.created_at),
    };
  });
}
