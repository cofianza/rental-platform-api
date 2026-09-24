// ============================================================
// Reportes — Service (HP-360)
// ============================================================

import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { fromSupabaseError } from '@/lib/errors';
import { fetchAll } from '@/lib/fetchAll';
import type { PostgrestError } from '@supabase/supabase-js';
import { desdeBogota, hastaBogota, mesBogota } from '@/lib/fechaBogota';
import { viaPorRutaDeAprobacion, type ViaAprobacion } from '@/modules/estudios/tarifas';

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

/**
 * Rango del reporte en hora Colombia. Sin fechas: del 1° del mes de hace 6
 * meses a hoy. Con un solo extremo se completa el otro (antes el filtro se
 * descartaba en silencio y se veían los últimos 6 meses).
 */
function resolveRange(dateFrom?: string, dateTo?: string): { dateFrom: string; dateTo: string } {
  const fin = dateTo ? hastaBogota(dateTo) : new Date().toISOString();
  const [y, m] = mesBogota(fin).split('-').map(Number);
  const inicio = new Date(Date.UTC(y, m - 1 - 6, 1)).toISOString().slice(0, 10);
  return { dateFrom: desdeBogota(dateFrom ?? inicio), dateTo: fin };
}

function generateMonthKeys(dateFrom: string, dateTo: string): string[] {
  const keys: string[] = [];
  const startKey = mesBogota(dateFrom);
  const endKey = mesBogota(dateTo);

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

/** PostgREST corta en 1000 filas por respuesta: fetchAll pagina (con orden estable); aquí además lanza el error. */
async function todasLasFilas<T>(
  pagina: (desde: number, hasta: number) => PromiseLike<{ data: unknown; error: PostgrestError | null }>,
): Promise<T[]> {
  const { data, error } = await fetchAll(pagina as (d: number, h: number) => PromiseLike<{ data: T[] | null; error: PostgrestError | null }>);
  if (error) throw fromSupabaseError(error);
  return data;
}

// ── Service Function ────────────────────────────────────────

export async function getVolumenExpedientes(
  dateFrom?: string,
  dateTo?: string,
  estado?: string,
): Promise<VolumenExpedientesResult> {
  const range = resolveRange(dateFrom, dateTo);

  logger.debug({ range, estado }, 'Fetching volumen estudios');

  // Paginadas con fetchAll: PostgREST corta en 1000 filas.
  // Query 1: expedientes created in range (for "creados" count)
  const creadosQuery = (desde: number, hasta: number) => {
    let q = supabase
      .from('expedientes')
      .select('id, estado, created_at')
      .gte('created_at', range.dateFrom)
      .lte('created_at', range.dateTo);
    if (estado) q = q.eq('estado', estado);
    return q.order('id').range(desde, hasta);
  };

  // Query 2: "cerrado" = la PRIMERA vez que el estudio llegó a un estado final,
  // según el timeline. Antes se usaba updated_at, que cambia con cualquier
  // edición (generar el contrato, p.ej.): un estudio aprobado en marzo y tocado
  // en abril contaba como cerrado en abril. Sin límite inferior para saber
  // cuál fue la primera; se cuenta solo si cae en el rango.
  type EventoCierre = { expediente_id: string; created_at: string };
  const cerradosQuery = (desde: number, hasta: number) => {
    let q = supabase
      .from('eventos_timeline')
      .select('expediente_id, created_at, expedientes!inner(estado)')
      .in('estado_nuevo', ESTADOS_CERRADOS)
      .lte('created_at', range.dateTo);
    if (estado) q = q.eq('expedientes.estado', estado);
    return q.order('created_at', { ascending: true }).order('id', { ascending: true }).range(desde, hasta);
  };

  const [creadosResult, eventosCierre] = await Promise.all([
    fetchAll(creadosQuery),
    todasLasFilas<EventoCierre>(cerradosQuery),
  ]);

  if (creadosResult.error) throw fromSupabaseError(creadosResult.error);

  const creadosData = creadosResult.data ?? [];
  const primerCierre = new Map<string, string>();
  for (const ev of eventosCierre) {
    if (!primerCierre.has(ev.expediente_id)) primerCierre.set(ev.expediente_id, ev.created_at);
  }
  const desdeMs = new Date(range.dateFrom).getTime();
  const cerradosData = [...primerCierre.values()].filter((f) => new Date(f).getTime() >= desdeMs);

  // Build month map with all months in range
  const monthKeys = generateMonthKeys(range.dateFrom, range.dateTo);
  const monthMap = new Map<string, { creados: number; cerrados: number }>();

  for (const key of monthKeys) {
    monthMap.set(key, { creados: 0, cerrados: 0 });
  }

  // Count creados per month
  for (const row of creadosData) {
    const r = row as { id: string; estado: string; created_at: string };
    const key = mesBogota(r.created_at);
    const entry = monthMap.get(key);
    if (entry) {
      entry.creados++;
    } else {
      monthMap.set(key, { creados: 1, cerrados: 0 });
    }
  }

  // Count cerrados per month (por la fecha del primer cierre)
  for (const fecha of cerradosData) {
    const key = mesBogota(fecha);
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
//
// P26: cuenta la decisión VIGENTE de cada estudio según la línea de tiempo (la
// última entre aprobado, rechazado y condicionado), no su estado actual: el
// aprobado que llega a contrato termina 'cerrado', y el condicionado que el
// analista aprueba después cuenta como aprobado. Los aprobados se desglosan
// por ruta de aprobación (Adenda 2 §6, la misma vía que fija la tarifa) y los
// condicionados que siguen sin decidir van aparte, «en decisión», fuera de la
// tasa. Agrupa por el mes de creación del estudio, como el dashboard.

export interface AprobacionMes {
  periodo: string;
  aprobados: number;
  aprobados_automatica: number;
  aprobados_coarrendatario: number;
  aprobados_revision_manual: number;
  rechazados: number;
  /** En decisión: condicionados que el analista todavía no resuelve. No entran en la tasa. */
  condicionados: number;
  /** Decididos: aprobados + rechazados. */
  total: number;
  tasa: number;
}

export interface AprobacionResult {
  meses: AprobacionMes[];
  totales: {
    total_aprobados: number;
    total_aprobados_automatica: number;
    total_aprobados_coarrendatario: number;
    total_aprobados_revision_manual: number;
    total_rechazados: number;
    total_condicionados: number;
    total_resueltos: number;
    tasa_global: number;
  };
}

type Conteo = Omit<AprobacionMes, 'periodo' | 'total' | 'tasa'>;

const CONTEO_VACIO: Conteo = {
  aprobados: 0,
  aprobados_automatica: 0,
  aprobados_coarrendatario: 0,
  aprobados_revision_manual: 0,
  rechazados: 0,
  condicionados: 0,
};

const CAMPO_VIA: Record<ViaAprobacion, keyof Conteo> = {
  automatica: 'aprobados_automatica',
  condicionada_coarrendatario: 'aprobados_coarrendatario',
  revision_manual: 'aprobados_revision_manual',
};

const tasaDe = (aprobados: number, decididos: number) =>
  decididos > 0 ? Math.round((aprobados / decididos) * 10000) / 100 : 0;

/**
 * Vía de aprobación de cada estudio aprobado, con los insumos de
 * viaPorRutaDeAprobacion (el mismo criterio del CRC): la última evaluación del
 * titular (la re-evaluación crea una nueva) y si lo aprobó la ponderación con
 * co-arrendatario. En lotes: la lista de ids va en la URL.
 */
async function viasDeAprobacion(
  aprobados: Array<{ id: string; ponderacion: boolean }>,
): Promise<Map<string, ViaAprobacion>> {
  type Estudio = { expediente_id: string; resultado: string | null; referencia_proveedor: string | null; cascada: unknown };
  const ultimo = new Map<string, Estudio>();
  for (let i = 0; i < aprobados.length; i += 100) {
    const ids = aprobados.slice(i, i + 100).map((a) => a.id);
    const { data, error } = await (supabase.from('estudios' as string) as ReturnType<typeof supabase.from>)
      .select('expediente_id, resultado, referencia_proveedor, cascada, created_at')
      .in('expediente_id', ids)
      .neq('tipo', 'con_coarrendatario')
      .order('created_at', { ascending: true });
    if (error) throw fromSupabaseError(error);
    for (const e of (data ?? []) as Estudio[]) ultimo.set(e.expediente_id, e);
  }
  return new Map(
    aprobados.map((a) => {
      const e = ultimo.get(a.id);
      const cascada = e?.cascada && typeof e.cascada === 'object' ? (e.cascada as { via?: unknown }) : null;
      return [
        a.id,
        viaPorRutaDeAprobacion({
          aprobadoPorPonderacion: a.ponderacion,
          viaMotor: cascada?.via ?? null,
          resultadoEstudio: e?.resultado ?? null,
          conReporteDeCentral: !!e?.referencia_proveedor,
        }),
      ];
    }),
  );
}

export async function getAprobacionExpedientes(
  dateFrom?: string,
  dateTo?: string,
): Promise<AprobacionResult> {
  const range = resolveRange(dateFrom, dateTo);

  logger.debug({ range }, 'Fetching aprobacion estudios');

  type EventoDecision = {
    expediente_id: string;
    estado_nuevo: string;
    metadata: { origen?: string } | null;
    expedientes: { created_at: string; estado: string } | null;
  };
  const eventos = await todasLasFilas<EventoDecision>((desde, hasta) =>
    (supabase.from('eventos_timeline' as string) as ReturnType<typeof supabase.from>)
      .select('expediente_id, estado_nuevo, metadata, expedientes!inner(created_at, estado)')
      .eq('tipo', 'estado')
      .in('estado_nuevo', ESTADOS_RESUELTOS)
      .gte('expedientes.created_at', range.dateFrom)
      .lte('expedientes.created_at', range.dateTo)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(desde, hasta),
  );

  // Orden ascendente: la última decisión gana.
  const decisiones = new Map<string, { ultima: string; mes: string; estado: string; ponderacion: boolean }>();
  for (const ev of eventos) {
    if (!ev.expedientes) continue;
    const d = decisiones.get(ev.expediente_id) ?? {
      ultima: ev.estado_nuevo,
      mes: mesBogota(ev.expedientes.created_at),
      estado: ev.expedientes.estado,
      ponderacion: false,
    };
    d.ultima = ev.estado_nuevo;
    if (ev.estado_nuevo === 'aprobado' && ev.metadata?.origen === 'ponderacion_coarrendatario') d.ponderacion = true;
    decisiones.set(ev.expediente_id, d);
  }

  const vias = await viasDeAprobacion(
    [...decisiones].filter(([, d]) => d.ultima === 'aprobado').map(([id, d]) => ({ id, ponderacion: d.ponderacion })),
  );

  const monthMap = new Map<string, Conteo>();
  for (const key of generateMonthKeys(range.dateFrom, range.dateTo)) monthMap.set(key, { ...CONTEO_VACIO });

  for (const [id, d] of decisiones) {
    // Un condicionado que se canceló sin decidir ya no está «en decisión»: no cuenta.
    if (d.ultima === 'condicionado' && d.estado !== 'condicionado') continue;
    const e = monthMap.get(d.mes) ?? { ...CONTEO_VACIO };
    monthMap.set(d.mes, e);
    if (d.ultima === 'aprobado') {
      e.aprobados++;
      e[CAMPO_VIA[vias.get(id) ?? 'revision_manual']]++;
    } else if (d.ultima === 'rechazado') e.rechazados++;
    else e.condicionados++;
  }

  const meses: AprobacionMes[] = [...monthMap.keys()].sort().map((key) => {
    const e = monthMap.get(key)!;
    const total = e.aprobados + e.rechazados;
    return { periodo: formatPeriodo(key), ...e, total, tasa: tasaDe(e.aprobados, total) };
  });

  const t = meses.reduce<Conteo>(
    (acc, m) => {
      for (const k of Object.keys(CONTEO_VACIO) as Array<keyof Conteo>) acc[k] += m[k];
      return acc;
    },
    { ...CONTEO_VACIO },
  );
  const total_resueltos = t.aprobados + t.rechazados;

  return {
    meses,
    totales: {
      total_aprobados: t.aprobados,
      total_aprobados_automatica: t.aprobados_automatica,
      total_aprobados_coarrendatario: t.aprobados_coarrendatario,
      total_aprobados_revision_manual: t.aprobados_revision_manual,
      total_rechazados: t.rechazados,
      total_condicionados: t.condicionados,
      total_resueltos,
      tasa_global: tasaDe(t.aprobados, total_resueltos),
    },
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
  const range = resolveRange(dateFrom, dateTo);

  logger.debug({ range, concepto }, 'Fetching ingresos reporte');

  // Query 1: completed pagos (ingresos). Paginadas: PostgREST corta en 1000 filas.
  const completadosQuery = (desde: number, hasta: number) => {
    let q = supabase
      .from('pagos')
      .select('id, monto, concepto, created_at')
      .eq('estado', 'completado')
      .gte('created_at', range.dateFrom)
      .lte('created_at', range.dateTo);
    if (concepto) q = q.eq('concepto', concepto);
    return q.order('id').range(desde, hasta);
  };

  // Query 2: pending pagos (total pendiente)
  const pendientesQuery = (desde: number, hasta: number) => {
    let q = supabase
      .from('pagos')
      .select('id, monto')
      .eq('estado', 'pendiente')
      .gte('created_at', range.dateFrom)
      .lte('created_at', range.dateTo);
    if (concepto) q = q.eq('concepto', concepto);
    return q.order('id').range(desde, hasta);
  };

  const [completadosResult, pendientesResult] = await Promise.all([
    fetchAll(completadosQuery),
    fetchAll(pendientesQuery),
  ]);

  if (completadosResult.error) throw fromSupabaseError(completadosResult.error);
  if (pendientesResult.error) throw fromSupabaseError(pendientesResult.error);

  const completadosData = completadosResult.data ?? [];
  const pendientesData = pendientesResult.data ?? [];

  // Group completed pagos by month + concepto
  const groupMap = new Map<string, { cantidad_pagos: number; monto_total: number }>();

  // Initialize all month keys (without concepto — we only create entries for actual data)
  for (const row of completadosData) {
    const r = row as { id: string; monto: number; concepto: string; created_at: string };
    const monthKey = mesBogota(r.created_at);
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
  en_revision: 'En revisión',
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
  const range = resolveRange(dateFrom, dateTo);

  logger.debug({ range }, 'Fetching tiempos por etapa');

  // 1. Transiciones de estado en el rango, paginadas (PostgREST corta en 1000
  //    filas y, en orden ascendente, se perdían las más recientes), con la
  //    creación del estudio: es el inicio de 'borrador' y del tiempo total.
  type Evento = {
    expediente_id: string;
    estado_anterior: string;
    estado_nuevo: string;
    created_at: string;
    expedientes: { created_at: string } | null;
  };
  const rows = await todasLasFilas<Evento>((desde, hasta) =>
    supabase
      .from('eventos_timeline')
      .select('expediente_id, estado_anterior, estado_nuevo, created_at, expedientes(created_at)')
      .not('estado_anterior', 'is', null)
      .not('estado_nuevo', 'is', null)
      .gte('created_at', range.dateFrom)
      .lte('created_at', range.dateTo)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(desde, hasta),
  );

  // 2. Group by expediente_id
  const byExpediente = new Map<string, { creado: string | null; events: Evento[] }>();

  for (const r of rows) {
    let entry = byExpediente.get(r.expediente_id);
    if (!entry) {
      entry = { creado: r.expedientes?.created_at ?? null, events: [] };
      byExpediente.set(r.expediente_id, entry);
    }
    entry.events.push(r);
  }

  // 3. Tiempo en cada estado = de la transición que lo abrió a la que lo cerró.
  //    'borrador' (visita, documentos y pago) se abre con la creación del
  //    estudio: no hay evento que entre a él. La permanencia en un estado final
  //    no es una etapa (aprobado → cerrado es todo el arriendo): no se mide.
  //    Tiempo total por estudio = de la creación a su primera decisión
  //    (aprobado o rechazado); antes se sumaban los promedios de cada etapa,
  //    que salían de estudios distintos e incluían los estados finales.
  const durationsMap = new Map<string, number[]>();
  const expedientesPerEstado = new Map<string, Set<string>>();
  const totales: number[] = [];
  const DIA_MS = 1000 * 60 * 60 * 24;

  for (const [expedienteId, { creado, events }] of byExpediente) {
    // events are already sorted by created_at (query ORDER BY)
    for (let i = 0; i < events.length; i++) {
      const curr = events[i];
      const estado = curr.estado_anterior;
      if (ESTADOS_CERRADOS.includes(estado)) continue;
      const inicio = i > 0 ? events[i - 1].created_at : estado === 'borrador' ? creado : null;
      if (!inicio) continue; // entró a este estado antes del rango
      const durationDays = (new Date(curr.created_at).getTime() - new Date(inicio).getTime()) / DIA_MS;

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

    const decision = events.find((e) => e.estado_nuevo === 'aprobado' || e.estado_nuevo === 'rechazado');
    if (decision && creado) {
      const dias = (new Date(decision.created_at).getTime() - new Date(creado).getTime()) / DIA_MS;
      if (dias >= 0) totales.push(dias);
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

  const tiempoTotalPromedio = totales.length ? totales.reduce((a, b) => a + b, 0) / totales.length : 0;

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
