// ============================================================
// Reportes — Service (HP-360)
// ============================================================

import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { fromSupabaseError } from '@/lib/errors';

// ── Types ───────────────────────────────────────────────────

export interface VolumenMes {
  periodo: string;
  creados: number;
  cerrados: number;
  neto: number;
}

export interface VolumenExpedientesResult {
  meses: VolumenMes[];
  total_creados: number;
  total_cerrados: number;
  total_neto: number;
}

// ── Constants ───────────────────────────────────────────────

const ESTADOS_CERRADOS = ['aprobado', 'rechazado', 'cerrado'];
const ESTADOS_RESUELTOS = ['aprobado', 'rechazado', 'condicionado'];

const MESES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

// ── Helpers ─────────────────────────────────────────────────

function formatPeriodo(yearMonth: string): string {
  const [year, month] = yearMonth.split('-');
  return `${MESES[parseInt(month, 10) - 1]} ${year}`;
}

function getDefaultDateRange(): { dateFrom: string; dateTo: string } {
  const now = new Date();
  const dateTo = now.toISOString();
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, 1);
  const dateFrom = sixMonthsAgo.toISOString();
  return { dateFrom, dateTo };
}

function toYearMonth(isoDate: string): string {
  const d = new Date(isoDate);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function generateMonthKeys(dateFrom: string, dateTo: string): string[] {
  const keys: string[] = [];
  const startKey = toYearMonth(dateFrom);
  const endKey = toYearMonth(dateTo);

  const [startYear, startMonth] = startKey.split('-').map(Number);
  const [endYear, endMonth] = endKey.split('-').map(Number);

  let year = startYear;
  let month = startMonth;

  while (year < endYear || (year === endYear && month <= endMonth)) {
    keys.push(`${year}-${String(month).padStart(2, '0')}`);
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
  }

  return keys;
}

// ── Service Function ────────────────────────────────────────

export async function getVolumenExpedientes(
  dateFrom?: string,
  dateTo?: string,
  estado?: string,
): Promise<VolumenExpedientesResult> {
  const range = dateFrom && dateTo
    ? { dateFrom, dateTo }
    : getDefaultDateRange();

  logger.debug({ range, estado }, 'Fetching volumen expedientes');

  // Query 1: expedientes created in range (for "creados" count)
  let creadosQuery = supabase
    .from('expedientes')
    .select('id, estado, created_at')
    .gte('created_at', range.dateFrom)
    .lte('created_at', range.dateTo);

  if (estado) {
    creadosQuery = creadosQuery.eq('estado', estado);
  }

  // Query 2: expedientes that reached terminal state in range (for "cerrados" count)
  let cerradosQuery = supabase
    .from('expedientes')
    .select('id, estado, updated_at')
    .in('estado', ESTADOS_CERRADOS)
    .gte('updated_at', range.dateFrom)
    .lte('updated_at', range.dateTo);

  if (estado) {
    cerradosQuery = cerradosQuery.eq('estado', estado);
  }

  const [creadosResult, cerradosResult] = await Promise.all([
    creadosQuery,
    cerradosQuery,
  ]);

  if (creadosResult.error) throw fromSupabaseError(creadosResult.error);
  if (cerradosResult.error) throw fromSupabaseError(cerradosResult.error);

  const creadosData = creadosResult.data ?? [];
  const cerradosData = cerradosResult.data ?? [];

  // Build month map with all months in range
  const monthKeys = generateMonthKeys(range.dateFrom, range.dateTo);
  const monthMap = new Map<string, { creados: number; cerrados: number }>();

  for (const key of monthKeys) {
    monthMap.set(key, { creados: 0, cerrados: 0 });
  }

  // Count creados per month
  for (const row of creadosData) {
    const r = row as { id: string; estado: string; created_at: string };
    const key = toYearMonth(r.created_at);
    const entry = monthMap.get(key);
    if (entry) {
      entry.creados++;
    } else {
      monthMap.set(key, { creados: 1, cerrados: 0 });
    }
  }

  // Count cerrados per month (by updated_at)
  for (const row of cerradosData) {
    const r = row as { id: string; estado: string; updated_at: string };
    const key = toYearMonth(r.updated_at);
    const entry = monthMap.get(key);
    if (entry) {
      entry.cerrados++;
    } else {
      monthMap.set(key, { creados: 0, cerrados: 1 });
    }
  }

  // Build sorted result
  const sortedKeys = [...monthMap.keys()].sort();
  const meses: VolumenMes[] = sortedKeys.map((key) => {
    const entry = monthMap.get(key)!;
    return {
      periodo: formatPeriodo(key),
      creados: entry.creados,
      cerrados: entry.cerrados,
      neto: entry.creados - entry.cerrados,
    };
  });

  let total_creados = 0;
  let total_cerrados = 0;
  for (const m of meses) {
    total_creados += m.creados;
    total_cerrados += m.cerrados;
  }

  return {
    meses,
    total_creados,
    total_cerrados,
    total_neto: total_creados - total_cerrados,
  };
}

// ── HP-361: Aprobacion ──────────────────────────────────────

export interface AprobacionMes {
  periodo: string;
  aprobados: number;
  rechazados: number;
  condicionados: number;
  total: number;
  tasa: number;
}

export interface AprobacionResult {
  meses: AprobacionMes[];
  totales: {
    total_aprobados: number;
    total_rechazados: number;
    total_condicionados: number;
    total_resueltos: number;
    tasa_global: number;
  };
}

export async function getAprobacionExpedientes(
  dateFrom?: string,
  dateTo?: string,
): Promise<AprobacionResult> {
  const range = dateFrom && dateTo
    ? { dateFrom, dateTo }
    : getDefaultDateRange();

  logger.debug({ range }, 'Fetching aprobacion expedientes');

  const { data, error } = await supabase
    .from('expedientes')
    .select('id, estado, created_at')
    .in('estado', ESTADOS_RESUELTOS)
    .gte('created_at', range.dateFrom)
    .lte('created_at', range.dateTo);

  if (error) throw fromSupabaseError(error);

  const rows = data ?? [];
  const monthKeys = generateMonthKeys(range.dateFrom, range.dateTo);
  const monthMap = new Map<string, { aprobados: number; rechazados: number; condicionados: number }>();

  for (const key of monthKeys) {
    monthMap.set(key, { aprobados: 0, rechazados: 0, condicionados: 0 });
  }

  for (const row of rows) {
    const r = row as { id: string; estado: string; created_at: string };
    const key = toYearMonth(r.created_at);
    let entry = monthMap.get(key);
    if (!entry) {
      entry = { aprobados: 0, rechazados: 0, condicionados: 0 };
      monthMap.set(key, entry);
    }
    if (r.estado === 'aprobado') entry.aprobados++;
    else if (r.estado === 'rechazado') entry.rechazados++;
    else if (r.estado === 'condicionado') entry.condicionados++;
  }

  const sortedKeys = [...monthMap.keys()].sort();
  const meses: AprobacionMes[] = sortedKeys.map((key) => {
    const e = monthMap.get(key)!;
    const total = e.aprobados + e.rechazados + e.condicionados;
    const tasa = total > 0 ? Math.round((e.aprobados / total) * 10000) / 100 : 0;
    return {
      periodo: formatPeriodo(key),
      aprobados: e.aprobados,
      rechazados: e.rechazados,
      condicionados: e.condicionados,
      total,
      tasa,
    };
  });

  let total_aprobados = 0;
  let total_rechazados = 0;
  let total_condicionados = 0;
  for (const m of meses) {
    total_aprobados += m.aprobados;
    total_rechazados += m.rechazados;
    total_condicionados += m.condicionados;
  }
  const total_resueltos = total_aprobados + total_rechazados + total_condicionados;
  const tasa_global = total_resueltos > 0
    ? Math.round((total_aprobados / total_resueltos) * 10000) / 100
    : 0;

  return {
    meses,
    totales: { total_aprobados, total_rechazados, total_condicionados, total_resueltos, tasa_global },
  };
}

// ── HP-362: Ingresos ──────────────────────────────────────

export interface IngresosMes {
  periodo: string;
  concepto: string;
  cantidad_pagos: number;
  monto_total: number;
}

export interface IngresosResult {
  meses: IngresosMes[];
  resumen: {
    total_ingresos: number;
    total_pendiente: number;
    cantidad_pagos: number;
  };
}

export async function getIngresosReporte(
  dateFrom?: string,
  dateTo?: string,
  concepto?: string,
): Promise<IngresosResult> {
  const range = dateFrom && dateTo
    ? { dateFrom, dateTo }
    : getDefaultDateRange();

  logger.debug({ range, concepto }, 'Fetching ingresos reporte');

  // Query 1: completed pagos (ingresos)
  let completadosQuery = supabase
    .from('pagos')
    .select('id, monto, concepto, created_at')
    .eq('estado', 'completado')
    .gte('created_at', range.dateFrom)
    .lte('created_at', range.dateTo);

  // Query 2: pending pagos (total pendiente)
  let pendientesQuery = supabase
    .from('pagos')
    .select('id, monto')
    .eq('estado', 'pendiente')
    .gte('created_at', range.dateFrom)
    .lte('created_at', range.dateTo);

  if (concepto) {
    completadosQuery = completadosQuery.eq('concepto', concepto);
    pendientesQuery = pendientesQuery.eq('concepto', concepto);
  }

  const [completadosResult, pendientesResult] = await Promise.all([
    completadosQuery,
    pendientesQuery,
  ]);

  if (completadosResult.error) throw fromSupabaseError(completadosResult.error);
  if (pendientesResult.error) throw fromSupabaseError(pendientesResult.error);

  const completadosData = completadosResult.data ?? [];
  const pendientesData = pendientesResult.data ?? [];

  // Group completed pagos by month + concepto
  const monthKeys = generateMonthKeys(range.dateFrom, range.dateTo);
  const groupMap = new Map<string, { cantidad_pagos: number; monto_total: number }>();

  // Initialize all month keys (without concepto — we only create entries for actual data)
  for (const row of completadosData) {
    const r = row as { id: string; monto: number; concepto: string; created_at: string };
    const monthKey = toYearMonth(r.created_at);
    const groupKey = `${monthKey}|${r.concepto}`;
    const entry = groupMap.get(groupKey);
    if (entry) {
      entry.cantidad_pagos++;
      entry.monto_total += Number(r.monto);
    } else {
      groupMap.set(groupKey, { cantidad_pagos: 1, monto_total: Number(r.monto) });
    }
  }

  // Build sorted result
  const sortedGroupKeys = [...groupMap.keys()].sort();
  const meses: IngresosMes[] = sortedGroupKeys.map((groupKey) => {
    const [monthKey, conceptoValue] = groupKey.split('|');
    const entry = groupMap.get(groupKey)!;
    return {
      periodo: formatPeriodo(monthKey),
      concepto: conceptoValue,
      cantidad_pagos: entry.cantidad_pagos,
      monto_total: Math.round(entry.monto_total * 100) / 100,
    };
  });

  // Compute resumen
  let total_ingresos = 0;
  let cantidad_pagos = 0;
  for (const m of meses) {
    total_ingresos += m.monto_total;
    cantidad_pagos += m.cantidad_pagos;
  }

  let total_pendiente = 0;
  for (const row of pendientesData) {
    const r = row as { id: string; monto: number };
    total_pendiente += Number(r.monto);
  }

  return {
    meses,
    resumen: {
      total_ingresos: Math.round(total_ingresos * 100) / 100,
      total_pendiente: Math.round(total_pendiente * 100) / 100,
      cantidad_pagos,
    },
  };
}

// ── HP-363: Tiempos por Etapa ─────────────────────────────

export interface TiempoEtapa {
  etapa: string;
  promedio_dias: number;
  minimo_dias: number;
  maximo_dias: number;
  cantidad_expedientes: number;
  es_cuello_botella: boolean;
}

export interface TiemposResult {
  etapas: TiempoEtapa[];
  resumen: {
    tiempo_total_promedio_dias: number;
    etapa_mas_lenta: string;
    etapa_mas_rapida: string;
    total_expedientes_analizados: number;
  };
}

const WORKFLOW_ORDER = [
  'borrador', 'en_revision', 'informacion_incompleta',
  'aprobado', 'condicionado', 'rechazado', 'cerrado',
];

const ESTADO_LABELS: Record<string, string> = {
  borrador: 'Borrador',
  en_revision: 'En Revision',
  informacion_incompleta: 'Info. Incompleta',
  aprobado: 'Aprobado',
  rechazado: 'Rechazado',
  condicionado: 'Condicionado',
  cerrado: 'Cerrado',
};

export async function getTiemposPorEtapa(
  dateFrom?: string,
  dateTo?: string,
): Promise<TiemposResult> {
  const range = dateFrom && dateTo
    ? { dateFrom, dateTo }
    : getDefaultDateRange();

  logger.debug({ range }, 'Fetching tiempos por etapa');

  // 1. Fetch all timeline events with state transitions in range
  const { data, error } = await supabase
    .from('eventos_timeline')
    .select('expediente_id, estado_anterior, estado_nuevo, created_at')
    .not('estado_anterior', 'is', null)
    .not('estado_nuevo', 'is', null)
    .gte('created_at', range.dateFrom)
    .lte('created_at', range.dateTo)
    .order('created_at', { ascending: true });

  if (error) throw fromSupabaseError(error);

  const rows = data ?? [];

  // 2. Group by expediente_id
  const byExpediente = new Map<string, Array<{ estado_anterior: string; estado_nuevo: string; created_at: string }>>();

  for (const row of rows) {
    const r = row as { expediente_id: string; estado_anterior: string; estado_nuevo: string; created_at: string };
    let list = byExpediente.get(r.expediente_id);
    if (!list) {
      list = [];
      byExpediente.set(r.expediente_id, list);
    }
    list.push({ estado_anterior: r.estado_anterior, estado_nuevo: r.estado_nuevo, created_at: r.created_at });
  }

  // 3. For each expediente's events, calculate duration in each state
  // Each event means: estado_anterior ended at this event's created_at.
  // Time in estado_anterior = this_event.created_at - previous_event.created_at (same expediente).
  // For the first event we don't know when the state was entered, so skip it.
  const durationsMap = new Map<string, number[]>();
  const expedientesPerEstado = new Map<string, Set<string>>();

  for (const [expedienteId, events] of byExpediente) {
    // events are already sorted by created_at (query ORDER BY)
    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1];
      const curr = events[i];
      const estado = curr.estado_anterior;
      const durationMs = new Date(curr.created_at).getTime() - new Date(prev.created_at).getTime();
      const durationDays = durationMs / (1000 * 60 * 60 * 24);

      if (durationDays < 0) continue; // safety check

      let durations = durationsMap.get(estado);
      if (!durations) {
        durations = [];
        durationsMap.set(estado, durations);
      }
      durations.push(durationDays);

      let expSet = expedientesPerEstado.get(estado);
      if (!expSet) {
        expSet = new Set();
        expedientesPerEstado.set(estado, expSet);
      }
      expSet.add(expedienteId);
    }
  }

  // 4. Calculate avg, min, max for each estado
  const etapasUnsorted: TiempoEtapa[] = [];
  let sumAllAvg = 0;
  let countEstados = 0;

  for (const [estado, durations] of durationsMap) {
    if (durations.length === 0) continue;

    const sum = durations.reduce((a, b) => a + b, 0);
    const avg = sum / durations.length;
    const min = Math.min(...durations);
    const max = Math.max(...durations);
    const count = expedientesPerEstado.get(estado)?.size ?? 0;

    etapasUnsorted.push({
      etapa: ESTADO_LABELS[estado] ?? estado,
      promedio_dias: Math.round(avg * 100) / 100,
      minimo_dias: Math.round(min * 100) / 100,
      maximo_dias: Math.round(max * 100) / 100,
      cantidad_expedientes: count,
      es_cuello_botella: false, // set below
    });

    sumAllAvg += avg;
    countEstados++;
  }

  // 5. Mark bottlenecks: etapas where promedio > overall average
  const overallAvg = countEstados > 0 ? sumAllAvg / countEstados : 0;
  for (const etapa of etapasUnsorted) {
    etapa.es_cuello_botella = etapa.promedio_dias > Math.round(overallAvg * 100) / 100;
  }

  // 6. Sort by WORKFLOW_ORDER
  const orderIndex = new Map(WORKFLOW_ORDER.map((s, i) => [ESTADO_LABELS[s] ?? s, i]));
  const etapas = etapasUnsorted.sort((a, b) => {
    const ia = orderIndex.get(a.etapa) ?? 999;
    const ib = orderIndex.get(b.etapa) ?? 999;
    return ia - ib;
  });

  // 7. Build resumen
  const etapaMasLenta = etapas.length > 0
    ? etapas.reduce((prev, curr) => curr.promedio_dias > prev.promedio_dias ? curr : prev).etapa
    : 'N/A';
  const etapaMasRapida = etapas.length > 0
    ? etapas.reduce((prev, curr) => curr.promedio_dias < prev.promedio_dias ? curr : prev).etapa
    : 'N/A';

  const tiempoTotalPromedio = etapas.reduce((sum, e) => sum + e.promedio_dias, 0);

  return {
    etapas,
    resumen: {
      tiempo_total_promedio_dias: Math.round(tiempoTotalPromedio * 100) / 100,
      etapa_mas_lenta: etapaMasLenta,
      etapa_mas_rapida: etapaMasRapida,
      total_expedientes_analizados: byExpediente.size,
    },
  };
}
