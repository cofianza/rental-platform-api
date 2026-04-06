// ============================================================
// Dashboard — Service (HP-358)
// ============================================================

import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { AppError, fromSupabaseError } from '@/lib/errors';

// ── Types ───────────────────────────────────────────────────

export interface DashboardSummary {
  totalExpedientesActivos: number;
  expedientesPorEstado: Record<string, number>;
  tasaAprobacion: number;
  tiempoPromedioResolucionDias: number;
  ingresosDelPeriodo: number;
}

export interface ExpedientesPorEstado {
  estado: string;
  count: number;
}

// ── Cache ───────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, timestamp: Date.now() });
}

// ── Helpers ─────────────────────────────────────────────────

function getDefaultDateRange(): { dateFrom: string; dateTo: string } {
  const now = new Date();
  const dateFrom = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const dateTo = now.toISOString();
  return { dateFrom, dateTo };
}

function buildCacheKey(prefix: string, dateFrom: string, dateTo: string): string {
  return `${prefix}:${dateFrom}:${dateTo}`;
}

// ── Estado terminal (para tasa de aprobación y tiempo resolución) ──

const ESTADOS_TERMINALES = ['aprobado', 'rechazado', 'condicionado', 'cerrado'];

// ── Service Functions ───────────────────────────────────────

export async function getSummary(
  dateFrom?: string,
  dateTo?: string,
): Promise<DashboardSummary> {
  const range = dateFrom && dateTo
    ? { dateFrom, dateTo }
    : getDefaultDateRange();

  const cacheKey = buildCacheKey('summary', range.dateFrom, range.dateTo);
  const cached = getCached<DashboardSummary>(cacheKey);
  if (cached) {
    logger.debug({ cacheKey }, 'Dashboard summary served from cache');
    return cached;
  }

  // Run all queries in parallel
  const [
    expedientesActivos,
    porEstado,
    tasaAprobacionData,
    tiempoPromedio,
    ingresos,
  ] = await Promise.all([
    queryExpedientesActivos(),
    queryExpedientesPorEstado(range.dateFrom, range.dateTo),
    queryTasaAprobacion(range.dateFrom, range.dateTo),
    queryTiempoPromedioResolucion(range.dateFrom, range.dateTo),
    queryIngresosDelPeriodo(range.dateFrom, range.dateTo),
  ]);

  // Build expedientesPorEstado as a record
  const estadoRecord: Record<string, number> = {};
  for (const item of porEstado) {
    estadoRecord[item.estado] = item.count;
  }

  const summary: DashboardSummary = {
    totalExpedientesActivos: expedientesActivos,
    expedientesPorEstado: estadoRecord,
    tasaAprobacion: tasaAprobacionData,
    tiempoPromedioResolucionDias: tiempoPromedio,
    ingresosDelPeriodo: ingresos,
  };

  setCache(cacheKey, summary);
  return summary;
}

export async function getExpedientesPorEstado(
  dateFrom?: string,
  dateTo?: string,
): Promise<ExpedientesPorEstado[]> {
  const range = dateFrom && dateTo
    ? { dateFrom, dateTo }
    : getDefaultDateRange();

  const cacheKey = buildCacheKey('por-estado', range.dateFrom, range.dateTo);
  const cached = getCached<ExpedientesPorEstado[]>(cacheKey);
  if (cached) {
    logger.debug({ cacheKey }, 'Dashboard expedientes-por-estado served from cache');
    return cached;
  }

  const result = await queryExpedientesPorEstado(range.dateFrom, range.dateTo);
  setCache(cacheKey, result);
  return result;
}

// ── Query: Expedientes activos (no cancelados) ─────────────

async function queryExpedientesActivos(): Promise<number> {
  const { count, error } = await supabase
    .from('expedientes')
    .select('*', { count: 'exact', head: true })
    .neq('estado', 'cerrado');

  if (error) throw fromSupabaseError(error);
  return count ?? 0;
}

// ── Query: Conteo por estado ────────────────────────────────

async function queryExpedientesPorEstado(
  dateFrom: string,
  dateTo: string,
): Promise<ExpedientesPorEstado[]> {
  const { data, error } = await supabase
    .from('expedientes')
    .select('estado')
    .gte('created_at', dateFrom)
    .lte('created_at', dateTo);

  if (error) throw fromSupabaseError(error);
  if (!data) return [];

  // Count in memory (Supabase JS client doesn't support GROUP BY directly)
  const counts: Record<string, number> = {};
  for (const row of data) {
    const estado = (row as { estado: string }).estado;
    counts[estado] = (counts[estado] || 0) + 1;
  }

  return Object.entries(counts).map(([estado, count]) => ({ estado, count }));
}

// ── Query: Tasa de aprobación ───────────────────────────────

async function queryTasaAprobacion(
  dateFrom: string,
  dateTo: string,
): Promise<number> {
  const { data, error } = await supabase
    .from('expedientes')
    .select('estado')
    .in('estado', ESTADOS_TERMINALES)
    .gte('created_at', dateFrom)
    .lte('created_at', dateTo);

  if (error) throw fromSupabaseError(error);
  if (!data || data.length === 0) return 0;

  const aprobados = data.filter((row) => (row as { estado: string }).estado === 'aprobado').length;
  return Math.round((aprobados / data.length) * 10000) / 100; // 2 decimal places
}

// ── Query: Tiempo promedio resolución (días) ────────────────

async function queryTiempoPromedioResolucion(
  dateFrom: string,
  dateTo: string,
): Promise<number> {
  const { data, error } = await supabase
    .from('expedientes')
    .select('created_at, updated_at, estado')
    .in('estado', ESTADOS_TERMINALES)
    .gte('created_at', dateFrom)
    .lte('created_at', dateTo);

  if (error) throw fromSupabaseError(error);
  if (!data || data.length === 0) return 0;

  let totalDays = 0;
  let count = 0;

  for (const row of data) {
    const r = row as { created_at: string; updated_at: string };
    const created = new Date(r.created_at).getTime();
    const resolved = new Date(r.updated_at).getTime();
    const diffDays = (resolved - created) / (1000 * 60 * 60 * 24);
    if (diffDays >= 0) {
      totalDays += diffDays;
      count++;
    }
  }

  if (count === 0) return 0;
  return Math.round((totalDays / count) * 100) / 100; // 2 decimal places
}

// ── Query: Ingresos del período (pagos completados) ─────────

async function queryIngresosDelPeriodo(
  dateFrom: string,
  dateTo: string,
): Promise<number> {
  const { data, error } = await supabase
    .from('pagos')
    .select('monto')
    .eq('estado', 'completado')
    .gte('created_at', dateFrom)
    .lte('created_at', dateTo);

  if (error) throw fromSupabaseError(error);
  if (!data) return 0;

  let total = 0;
  for (const row of data) {
    const monto = (row as { monto: number }).monto;
    if (typeof monto === 'number') {
      total += monto;
    }
  }

  return total;
}
