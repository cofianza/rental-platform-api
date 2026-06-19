// ============================================================
// Dashboard — Service (HP-358)
// ============================================================

import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { fromSupabaseError } from '@/lib/errors';
import { resolvePortfolioInmuebleIds } from '@/lib/tenantScope';

// ── Constantes para vista admin ─────────────────────────────
//
// "Por vencer" = contrato vigente cuyo fecha_fin cae dentro de los
// próximos N días. Usamos 60 para alinearnos con la práctica del negocio
// de gestionar renovaciones con anticipación.
const POR_VENCER_DIAS = 60;

// Estados de contrato que cuentan como "activos" para el dashboard:
// firmado = listo para iniciar, vigente = corriendo. Excluimos borrador,
// pendiente_firma, finalizado, cancelado.
const ESTADOS_CONTRATO_ACTIVO = ['firmado', 'vigente'] as const;

// Estados de contrato que representan una tenencia real (para historial de
// inquilinos): incluye los terminados además de los vigentes. Excluye
// borrador/pendiente_firma/en_revision/aprobado (aún no son una tenencia).
const ESTADOS_CONTRATO_HISTORIAL = ['firmado', 'vigente', 'finalizado', 'cancelado'] as const;

// Estados de mora que cuentan como "activos" (no resueltos).
const ESTADOS_MORA_ACTIVA = ['fase_1', 'fase_2', 'fase_3'] as const;

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

// ── Portfolio Stats (propietario/inmobiliaria) ─────────────
//
// Resumen para el hero "Tu Oficina Virtual": 3 cards. No usa el cache
// global porque depende del usuario.
//   - propiedades_activas: inmuebles del propietario (cualquier estado
//     excepto soft-delete)
//   - inquilinos_cartera: contratos en estado firmado/vigente sobre
//     inmuebles del propietario
//   - canon_mensual: suma de valor_arriendo de contratos activos
//     (equivale al "recaudado este mes" cuando todo el portafolio
//     paga al dia)

export interface PortfolioStats {
  propiedades_activas: number;
  inquilinos_cartera: number;
  canon_mensual: number;
}

export async function getPortfolioStats(perfilId: string): Promise<PortfolioStats> {
  // 1) Inmuebles del portafolio (org-aware: incluye la cartera de la organización)
  const inmuebleIds = await resolvePortfolioInmuebleIds(perfilId);
  const propiedades_activas = inmuebleIds.length;

  if (inmuebleIds.length === 0) {
    return { propiedades_activas: 0, inquilinos_cartera: 0, canon_mensual: 0 };
  }

  // 2) Expedientes vinculados a esos inmuebles (necesario porque
  //    contratos no apunta directamente a inmueble — pasa por expediente).
  const { data: expedientes, error: expError } = await supabase
    .from('expedientes')
    .select('id, solicitante_id, inmueble_id')
    .in('inmueble_id', inmuebleIds);

  if (expError) throw fromSupabaseError(expError);

  const expedienteIds = (expedientes ?? []).map((e) => (e as { id: string }).id);
  const expedienteSolicitante: Record<string, string | null> = {};
  for (const e of expedientes ?? []) {
    const row = e as { id: string; solicitante_id: string | null };
    expedienteSolicitante[row.id] = row.solicitante_id;
  }

  if (expedienteIds.length === 0) {
    return { propiedades_activas, inquilinos_cartera: 0, canon_mensual: 0 };
  }

  // 3) Contratos activos sobre esos expedientes
  const { data: contratos, error: contError } = await supabase
    .from('contratos')
    .select('expediente_id, valor_arriendo, estado')
    .in('expediente_id', expedienteIds)
    .in('estado', ['firmado', 'vigente']);

  if (contError) throw fromSupabaseError(contError);

  const solicitantesUnicos = new Set<string>();
  let canon_mensual = 0;
  for (const c of contratos ?? []) {
    const row = c as { expediente_id: string; valor_arriendo: number | null };
    const sol = expedienteSolicitante[row.expediente_id];
    if (sol) solicitantesUnicos.add(sol);
    if (typeof row.valor_arriendo === 'number') canon_mensual += row.valor_arriendo;
  }

  return {
    propiedades_activas,
    inquilinos_cartera: solicitantesUnicos.size,
    canon_mensual,
  };
}

// ── Mis Inmuebles (propietario) — tarjetas con inquilino/contrato/pago ──
//
// Para el dashboard del propietario (mockup 14). Por cada inmueble del
// propietario devuelve sus datos + inquilino actual, vencimiento del contrato,
// estado de pago (vía moras_tickets) y si tiene garantía Cofianza activa
// (= contrato firmado/vigente). Sin invención: NO existe "tier" Base/Plus en el
// esquema, por eso la garantía es activa / sin garantía (sin nivel).

export interface HistorialInquilino {
  inquilino: string;
  desde: string | null; // fecha_inicio
  hasta: string | null; // fecha_fin (null = en curso)
  estado: string; // estado del contrato (vigente/firmado/finalizado/cancelado)
}

export interface MiInmuebleRow {
  id: string;
  codigo: string | null;
  direccion: string | null;
  ciudad: string | null;
  tipo: string | null;
  canon: number;
  habitaciones: number | null;
  banos: number | null;
  area: number | null;
  estado: string; // disponible | en_estudio | ocupado | inactivo
  visibleVitrina: boolean;
  inquilino: string | null;
  expedienteId: string | null;
  contratoId: string | null;
  venceContrato: string | null;
  garantiaActiva: boolean;
  pago: 'al_dia' | 'mora' | null; // null cuando no hay inquilino
  historial: HistorialInquilino[];
}

export interface MisInmueblesData {
  resumen: { total: number; arrendados: number; disponibles: number; enVitrina: number; ingresoMes: number };
  inmuebles: MiInmuebleRow[];
}

export async function getMisInmuebles(perfilId: string): Promise<MisInmueblesData> {
  // 1) Inmuebles del portafolio (org-aware)
  const portfolioIds = await resolvePortfolioInmuebleIds(perfilId);
  const { data: inmData, error: e1 } = await supabase
    .from('inmuebles')
    .select(
      'id, codigo, direccion, ciudad, tipo, valor_arriendo, habitaciones, banos, area_m2, estado, visible_vitrina, created_at',
    )
    .in('id', portfolioIds)
    .order('created_at', { ascending: false });
  if (e1) throw fromSupabaseError(e1);
  const inms = (inmData ?? []) as Array<Record<string, unknown>>;
  const inmuebleIds = inms.map((i) => i.id as string);

  // inmueble_id → datos del contrato activo (1 por inmueble)
  const activoPorInmueble = new Map<
    string,
    { inquilino: string | null; expedienteId: string; contratoId: string; venceContrato: string | null }
  >();
  const historialPorInmueble = new Map<string, HistorialInquilino[]>();
  const contratoIds: string[] = [];

  if (inmuebleIds.length > 0) {
    // 2) Expedientes de esos inmuebles
    const { data: exps, error: e2 } = await supabase
      .from('expedientes')
      .select('id, inmueble_id')
      .in('inmueble_id', inmuebleIds);
    if (e2) throw fromSupabaseError(e2);
    const expToInmueble = new Map<string, string>();
    const expedienteIds: string[] = [];
    for (const e of (exps ?? []) as Array<{ id: string; inmueble_id: string | null }>) {
      if (e.inmueble_id) {
        expToInmueble.set(e.id, e.inmueble_id);
        expedienteIds.push(e.id);
      }
    }

    // 3) Contratos (historial de tenencias + contrato activo) de esos expedientes.
    //    Orden desc por fecha_inicio → el primer firmado/vigente es el más reciente.
    if (expedienteIds.length > 0) {
      const { data: conts, error: e3 } = await (
        supabase.from('contratos' as string) as ReturnType<typeof supabase.from>
      )
        .select('id, expediente_id, fecha_inicio, fecha_fin, estado, expedientes(solicitantes(nombre, apellido))')
        .in('expediente_id', expedienteIds)
        .in('estado', ESTADOS_CONTRATO_HISTORIAL as unknown as string[])
        .order('fecha_inicio', { ascending: false });
      if (e3) throw fromSupabaseError(e3);
      const activos = ESTADOS_CONTRATO_ACTIVO as unknown as string[];
      for (const c of (conts ?? []) as Array<Record<string, unknown>>) {
        const expId = c.expediente_id as string;
        const inmId = expToInmueble.get(expId);
        if (!inmId) continue;
        const sol =
          (c.expedientes as { solicitantes?: { nombre: string | null; apellido: string | null } | null } | null)
            ?.solicitantes ?? null;
        const inquilino = sol ? `${sol.nombre ?? ''} ${sol.apellido ?? ''}`.trim() || null : null;

        // Historial: todas las tenencias del inmueble.
        const arr = historialPorInmueble.get(inmId) ?? [];
        arr.push({
          inquilino: inquilino ?? '—',
          desde: (c.fecha_inicio as string) ?? null,
          hasta: (c.fecha_fin as string) ?? null,
          estado: c.estado as string,
        });
        historialPorInmueble.set(inmId, arr);

        // Contrato activo (el más reciente firmado/vigente) → alimenta la tarjeta.
        if (activos.includes(c.estado as string) && !activoPorInmueble.has(inmId)) {
          activoPorInmueble.set(inmId, {
            inquilino,
            expedienteId: expId,
            contratoId: c.id as string,
            venceContrato: (c.fecha_fin as string) ?? null,
          });
          contratoIds.push(c.id as string);
        }
      }
    }
  }

  // 4) Moras activas → estado de pago por contrato
  const conMora = new Set<string>();
  if (contratoIds.length > 0) {
    const { data: moras, error: e4 } = await (
      supabase.from('moras_tickets' as string) as ReturnType<typeof supabase.from>
    )
      .select('contrato_id, estado')
      .in('contrato_id', contratoIds)
      .in('estado', ESTADOS_MORA_ACTIVA as unknown as string[]);
    if (e4) throw fromSupabaseError(e4);
    for (const m of (moras ?? []) as Array<{ contrato_id: string }>) conMora.add(m.contrato_id);
  }

  const inmuebles: MiInmuebleRow[] = inms.map((i) => {
    const id = i.id as string;
    const activo = activoPorInmueble.get(id);
    return {
      id,
      codigo: (i.codigo as string) ?? null,
      direccion: (i.direccion as string) ?? null,
      ciudad: (i.ciudad as string) ?? null,
      tipo: (i.tipo as string) ?? null,
      canon: Number(i.valor_arriendo ?? 0),
      habitaciones: (i.habitaciones as number) ?? null,
      banos: (i.banos as number) ?? null,
      area: (i.area_m2 as number) ?? null,
      estado: (i.estado as string) ?? 'disponible',
      visibleVitrina: Boolean(i.visible_vitrina),
      inquilino: activo?.inquilino ?? null,
      expedienteId: activo?.expedienteId ?? null,
      contratoId: activo?.contratoId ?? null,
      venceContrato: activo?.venceContrato ?? null,
      garantiaActiva: !!activo,
      pago: activo ? (conMora.has(activo.contratoId) ? 'mora' : 'al_dia') : null,
      historial: historialPorInmueble.get(id) ?? [],
    };
  });

  return {
    resumen: {
      total: inmuebles.length,
      arrendados: inmuebles.filter((i) => i.garantiaActiva).length,
      // Disponible = sin contrato activo (evita doble conteo si el estado del
      // inmueble no se actualizó al firmar; arrendados + disponibles = total).
      disponibles: inmuebles.filter((i) => !i.garantiaActiva).length,
      enVitrina: inmuebles.filter((i) => i.visibleVitrina).length,
      ingresoMes: inmuebles.filter((i) => i.garantiaActiva).reduce((s, i) => s + i.canon, 0),
    },
    inmuebles,
  };
}

// ── Pagos a Cofianza (inmobiliaria) — comisión por contrato ─────
//
// Detalle de la comisión de intermediación por cada contrato activo del
// aliado (inmobiliaria), para el tab "Pagos a Cofianza". Comisión = canon ×
// comision_intermediacion_porcentaje (tasa GLOBAL real de configuracion_sistema,
// NO existe "tier" Base/Plus/Premium en el esquema). IVA estándar 19% sobre la
// comisión. Sin inventar: la tasa y los canon son reales; es una estimación a
// la tasa configurada (no hay un modelo de "consignación a Cofianza" en la BD).

export interface PagoCofianzaContratoRow {
  contratoId: string;
  inquilino: string;
  inmueble: string;
  canon: number;
  comision: number;
  iva: number;
  total: number;
}

export interface MisPagosCofianzaData {
  comisionPorcentaje: number;
  ivaPorcentaje: number;
  detalle: PagoCofianzaContratoRow[];
  totales: { canon: number; comision: number; iva: number; total: number };
}

export async function getMisPagosCofianza(perfilId: string): Promise<MisPagosCofianzaData> {
  const IVA_PCT = 19; // IVA estándar Colombia sobre la comisión de intermediación.

  // Tasa de comisión global (misma fuente que usa contratos.service).
  const { data: cfgRows } = await (
    supabase.from('configuracion_sistema' as string) as ReturnType<typeof supabase.from>
  )
    .select('clave, valor')
    .eq('clave', 'comision_intermediacion_porcentaje');
  const comisionPct =
    Number(((cfgRows ?? []) as Array<{ clave: string; valor: string }>)[0]?.valor) || 20;

  // Cadena portafolio (org-aware) → expedientes → contratos activos.
  const inmuebleIds = await resolvePortfolioInmuebleIds(perfilId);

  const detalle: PagoCofianzaContratoRow[] = [];
  if (inmuebleIds.length > 0) {
    const { data: exps } = await supabase
      .from('expedientes')
      .select('id')
      .in('inmueble_id', inmuebleIds);
    const expedienteIds = ((exps ?? []) as Array<{ id: string }>).map((e) => e.id);

    if (expedienteIds.length > 0) {
      const { data: conts, error } = await (
        supabase.from('contratos' as string) as ReturnType<typeof supabase.from>
      )
        .select('id, valor_arriendo, expedientes(inmuebles(codigo, direccion), solicitantes(nombre, apellido))')
        .in('expediente_id', expedienteIds)
        .in('estado', ESTADOS_CONTRATO_ACTIVO as unknown as string[]);
      if (error) throw fromSupabaseError(error);

      for (const c of (conts ?? []) as Array<Record<string, unknown>>) {
        const exp = c.expedientes as {
          inmuebles?: { codigo: string | null; direccion: string | null } | null;
          solicitantes?: { nombre: string | null; apellido: string | null } | null;
        } | null;
        const sol = exp?.solicitantes ?? null;
        const inm = exp?.inmuebles ?? null;
        const canon = Number(c.valor_arriendo ?? 0);
        const comision = Math.round((canon * comisionPct) / 100);
        const iva = Math.round((comision * IVA_PCT) / 100);
        detalle.push({
          contratoId: c.id as string,
          inquilino: sol ? `${sol.nombre ?? ''} ${sol.apellido ?? ''}`.trim() || '—' : '—',
          inmueble: inm ? formatInmueble(inm) : '—',
          canon,
          comision,
          iva,
          total: comision + iva,
        });
      }
    }
  }

  return {
    comisionPorcentaje: comisionPct,
    ivaPorcentaje: IVA_PCT,
    detalle,
    totales: {
      canon: detalle.reduce((s, d) => s + d.canon, 0),
      comision: detalle.reduce((s, d) => s + d.comision, 0),
      iva: detalle.reduce((s, d) => s + d.iva, 0),
      total: detalle.reduce((s, d) => s + d.total, 0),
    },
  };
}

// ── Analítica de cartera (inmobiliaria) ────────────────────
//
// Métricas REALES del propio aliado para el tab Analítica (mockup 13_v2):
// salud de cartera (contratos activos, morosidad, días prom. mora, canon) y
// desempeño de estudios (aprobados, score promedio, decisiones últimos 30 días).
// NO incluye tiers/comisión/cashback/comparación-sector (no existen / inventados).

export interface MiCarteraAnalitica {
  salud: {
    contratosActivos: number;
    morosidadPct: number;
    moraActiva: number;
    diasPromedioMora: number;
    canonGestionado: number;
  };
  estudios: {
    total: number;
    aprobados: number;
    scorePromedio: number | null;
    decisiones30d: {
      aprobados: number;
      condicionados: number;
      rechazados: number;
      total: number;
      tasaAprobacion: number;
    };
  };
}

export async function getMiCarteraAnalitica(perfilId: string): Promise<MiCarteraAnalitica> {
  const inmuebleIds = await resolvePortfolioInmuebleIds(perfilId);

  let expedienteIds: string[] = [];
  if (inmuebleIds.length) {
    const { data: exps } = await supabase.from('expedientes').select('id').in('inmueble_id', inmuebleIds);
    expedienteIds = ((exps ?? []) as Array<{ id: string }>).map((e) => e.id);
  }

  // Contratos activos + canon
  let contratosActivos = 0;
  let canonGestionado = 0;
  const contratoIds: string[] = [];
  if (expedienteIds.length) {
    const { data: conts } = await (
      supabase.from('contratos' as string) as ReturnType<typeof supabase.from>
    )
      .select('id, valor_arriendo')
      .in('expediente_id', expedienteIds)
      .in('estado', ESTADOS_CONTRATO_ACTIVO as unknown as string[]);
    for (const c of (conts ?? []) as Array<{ id: string; valor_arriendo: number | string | null }>) {
      contratosActivos += 1;
      canonGestionado += Number(c.valor_arriendo ?? 0);
      contratoIds.push(c.id);
    }
  }

  // Moras activas → morosidad + días promedio
  let moraActiva = 0;
  let diasPromedioMora = 0;
  if (contratoIds.length) {
    const { data: moras } = await (
      supabase.from('moras_tickets' as string) as ReturnType<typeof supabase.from>
    )
      .select('reportado_at, estado')
      .in('contrato_id', contratoIds)
      .in('estado', ESTADOS_MORA_ACTIVA as unknown as string[]);
    const rows = (moras ?? []) as Array<{ reportado_at: string }>;
    moraActiva = rows.length;
    if (rows.length) {
      const now = Date.now();
      const totalDias = rows.reduce(
        (s, m) => s + Math.max(0, Math.floor((now - new Date(m.reportado_at).getTime()) / 86_400_000)),
        0,
      );
      diasPromedioMora = Math.round((totalDias / rows.length) * 10) / 10;
    }
  }
  const morosidadPct = contratosActivos ? Math.round((moraActiva / contratosActivos) * 1000) / 10 : 0;

  // Estudios → aprobados, score promedio, decisiones últimos 30 días
  let total = 0;
  let aprobados = 0;
  let scoreSum = 0;
  let scoreN = 0;
  let d30Ap = 0;
  let d30Co = 0;
  let d30Re = 0;
  if (expedienteIds.length) {
    const { data: ests } = await (
      supabase.from('estudios' as string) as ReturnType<typeof supabase.from>
    )
      .select('resultado, score, created_at, fecha_completado')
      .in('expediente_id', expedienteIds);
    const treintaDias = Date.now() - 30 * 86_400_000;
    for (const e of (ests ?? []) as Array<{
      resultado: string | null;
      score: number | null;
      created_at: string;
      fecha_completado: string | null;
    }>) {
      total += 1;
      if (e.resultado === 'aprobado') aprobados += 1;
      if (e.score != null) {
        scoreSum += e.score;
        scoreN += 1;
      }
      const fecha = e.fecha_completado || e.created_at;
      if (fecha && new Date(fecha).getTime() >= treintaDias) {
        if (e.resultado === 'aprobado') d30Ap += 1;
        else if (e.resultado === 'condicionado') d30Co += 1;
        else if (e.resultado === 'rechazado') d30Re += 1;
      }
    }
  }
  const d30Total = d30Ap + d30Co + d30Re;

  return {
    salud: { contratosActivos, morosidadPct, moraActiva, diasPromedioMora, canonGestionado },
    estudios: {
      total,
      aprobados,
      scorePromedio: scoreN ? Math.round(scoreSum / scoreN) : null,
      decisiones30d: {
        aprobados: d30Ap,
        condicionados: d30Co,
        rechazados: d30Re,
        total: d30Total,
        tasaAprobacion: d30Total ? Math.round((d30Ap / d30Total) * 1000) / 10 : 0,
      },
    },
  };
}

// ── Admin Overview (Centro de Control) ──────────────────────
//
// Resumen agregado para el dashboard interno del administrador,
// basado en mockup htmls/15_COFIANZA_Dashboard_Interno_v2.html.
// Una sola llamada porque el frontend renderea todo de una. Cache 5min.
//
// Métricas NO calculables hoy (devuelven null/0 con flag):
//   - capital_libre: requiere módulo de tesorería
//   - desembolsado: requiere tabla de pagos Cofianza→propietario
//   - tickets_abiertos: requiere módulo de soporte (solo existe moras)
//   - vitrina_visitas_mes: requiere tracking de visitas
//
// Métricas parciales:
//   - comision/IVA: usa porcentaje global de configuracion_sistema
//     (el mockup mostraba tiers Base/Plus/Premium, eso es feature futura)

export interface AdminOverviewKpis {
  inmobiliariasActivas: number;
  contratosActivos: number;
  canonTotalMensual: number;
  siniestralidad: number;
  moraActivaCount: number;
  moraActivaMonto: number;
  zonaRiesgoCount: number;
  zonaRiesgoExposicion: number;
  ingresosFianzas: number;
  ivaRecaudado: number;
  exposicionMaxima: number;
  vitrinaPublicados: number;
  vitrinaProspectos: number;
  capitalLibre: number | null;
  // Capital disponible total (para mostrar "de $X" bajo capital libre).
  // null cuando la tesorería no está configurada.
  capitalDisponible: number | null;
  desembolsado: number;
  ticketsAbiertos: number;
  vitrinaVisitasMes: number;
}

export interface AdminOverviewConfig {
  // Tarifa plana mensual del servicio de afianzamiento (COP) por contrato.
  // Es el ingreso real de fianza de Cofianza (NO un % del canon).
  valorAfianzamientoMensual: number;
  // IVA aplicable a la garantía/fianza. Hoy '0' (exento) en configuracion_sistema.
  ivaGarantiaPorcentaje: number;
}

export interface AdminOverviewContratoItem {
  id: string;
  inquilino: string;
  inmueble: string;
  mes: number;
  fechaFin: string | null;
  canon: number;
}

export interface AdminOverviewMoraItem {
  id: string;
  ticketNumero: string;
  contratoId: string;
  inquilino: string;
  inmueble: string;
  fase: number;
  dias: number;
  monto: number;
}

export interface AdminOverviewActividadItem {
  id: string;
  usuario: string;
  accion: string;
  entidad: string;
  fecha: string;
}

export interface AdminOverviewHistItem {
  mes: string;
  ct: number;
  mr: number;
  r: number;
}

export interface AdminOverview {
  kpis: AdminOverviewKpis;
  config: AdminOverviewConfig;
  histSiniestralidad: AdminOverviewHistItem[];
  contratosPorVencer: AdminOverviewContratoItem[];
  contratosZonaRiesgo: AdminOverviewContratoItem[];
  moraActiva: AdminOverviewMoraItem[];
  actividadReciente: AdminOverviewActividadItem[];
  meta: {
    metricasNoDisponibles: string[];
  };
}

// Rows internos para tipar las queries (no se exportan).
interface ContratoActivoRow {
  id: string;
  estado: string;
  valor_arriendo: number | string | null;
  fecha_inicio: string | null;
  fecha_fin: string | null;
  expedientes: {
    inmuebles: { codigo: string | null; direccion: string | null } | null;
    solicitantes: { nombre: string | null; apellido: string | null } | null;
  } | null;
}

interface MoraTicketRow {
  id: string;
  ticket_numero: string;
  contrato_id: string;
  monto_mora: number;
  estado: string;
  reportado_at: string;
  pagada_at: string | null;
  inquilino_nombre: string;
  inmueble_codigo: string | null;
  inmueble_direccion: string | null;
  cofianza_pago_realizado: boolean | null;
  cofianza_pago_monto: number | null;
  cofianza_pago_fecha: string | null;
}

interface BitacoraRow {
  id: string;
  accion: string;
  entidad: string;
  created_at: string;
  perfiles: { nombre: string | null; apellido: string | null } | null;
}

interface ConfiguracionRow {
  clave: string;
  valor: string;
}

export async function getAdminOverview(): Promise<AdminOverview> {
  const cacheKey = 'admin-overview';
  const cached = getCached<AdminOverview>(cacheKey);
  if (cached) {
    logger.debug({ cacheKey }, 'Dashboard admin overview served from cache');
    return cached;
  }

  const [
    contratosActivos,
    contratosHistorico,
    moraTickets,
    bitacora,
    config,
    inmobiliariasActivas,
    vitrinaPublicados,
    vitrinaProspectos,
    vitrinaVisitasMes,
    ticketsAbiertos,
  ] = await Promise.all([
    fetchContratosActivos(),
    fetchContratosHistorico(),
    fetchMoraTickets(),
    fetchBitacoraReciente(),
    fetchConfigDashboard(),
    countInmobiliariasActivas(),
    countVitrinaPublicados(),
    countVitrinaProspectos(),
    countVitrinaVisitasMes(),
    countTicketsAbiertos(),
  ]);

  const now = new Date();

  // Enriquecer contratos con "mes transcurrido" y bandera "por vencer".
  const contratosEnriquecidos = contratosActivos.map((c) => {
    const mes = mesesTranscurridos(c.fecha_inicio, now);
    const porVencer = isPorVencer(c.fecha_fin, now);
    const canon = Number(c.valor_arriendo ?? 0);
    const inq = formatInquilino(c.expedientes?.solicitantes ?? null);
    const inm = formatInmueble(c.expedientes?.inmuebles ?? null);
    return { row: c, mes, porVencer, canon, inq, inm };
  });

  const totalActivos = contratosEnriquecidos.length;
  const canonTotalMensual = contratosEnriquecidos.reduce((s, c) => s + c.canon, 0);
  const enRiesgo = contratosEnriquecidos.filter((c) => isRiskMes(c.mes));
  const porVencer = contratosEnriquecidos.filter((c) => c.porVencer);

  // Moras activas (estado distinto a pagada/cancelada).
  const morasActivas = moraTickets.filter((m) =>
    (ESTADOS_MORA_ACTIVA as readonly string[]).includes(m.estado),
  );
  const moraActivaCount = morasActivas.length;
  const moraActivaMonto = morasActivas.reduce((s, m) => s + (m.monto_mora ?? 0), 0);
  const siniestralidad = totalActivos
    ? Math.round((moraActivaCount / totalActivos) * 1000) / 10
    : 0;

  // Contratos asociados a moras activas — ese canon se cuenta UNA vez como
  // exposición máxima (canon de mora) + canon de zona riesgo sin mora.
  const contratoIdsMora = new Set(morasActivas.map((m) => m.contrato_id));
  const canonMora = contratosEnriquecidos
    .filter((c) => contratoIdsMora.has(c.row.id))
    .reduce((s, c) => s + c.canon, 0);
  const canonRiesgoSinMora = enRiesgo
    .filter((c) => !contratoIdsMora.has(c.row.id))
    .reduce((s, c) => s + c.canon, 0);
  const exposicionMaxima = canonMora + canonRiesgoSinMora;
  const zonaRiesgoExposicion = enRiesgo.reduce((s, c) => s + c.canon, 0);

  // Ingresos por fianzas = tarifa plana mensual de afianzamiento × contratos
  // activos. Esa tarifa (valor_afianzamiento_mensual) es el fee real que cobra
  // Cofianza; NO es un % del canon (el % de "intermediación" es solo un campo
  // de display en el contrato — ver contratos.service.ts). IVA según la tasa
  // del concepto "garantía" (hoy exento → 0).
  const ivaPct = config.ivaGarantiaPorcentaje / 100;
  const ingresosFianzas = totalActivos * config.valorAfianzamientoMensual;
  const ivaRecaudado = Math.round(ingresosFianzas * ivaPct);

  // Histórico siniestralidad últimos 6 meses (incluyendo el actual).
  // Base = contratos que ALGUNA VEZ estuvieron activos (incluye finalizados/
  // cancelados con sus fechas), no solo los vigentes hoy — así el denominador
  // de meses pasados no queda subestimado.
  const histSiniestralidad = calcularHistoricoSiniestralidad(
    contratosHistorico,
    moraTickets.map((m) => ({ reportado_at: m.reportado_at })),
    now,
  );

  // Capital libre = capital_disponible - reserva_minima (configurado por admin).
  // Si ambas son 0 (config sin tocar) lo dejamos en null para que el frontend
  // muestre "sin configurar" en vez de un "0" engañoso.
  const capitalLibre = config.capitalDisponible > 0 || config.reservaMinima > 0
    ? Math.max(0, config.capitalDisponible - config.reservaMinima)
    : null;

  // Desembolsos pagados por Cofianza al propietario (campo en moras_tickets).
  const desembolsado = moraTickets
    .filter((m) => m.cofianza_pago_realizado === true)
    .reduce((s, m) => s + (m.cofianza_pago_monto ?? 0), 0);

  const overview: AdminOverview = {
    kpis: {
      inmobiliariasActivas,
      contratosActivos: totalActivos,
      canonTotalMensual,
      siniestralidad,
      moraActivaCount,
      moraActivaMonto,
      zonaRiesgoCount: enRiesgo.length,
      zonaRiesgoExposicion,
      ingresosFianzas,
      ivaRecaudado,
      exposicionMaxima,
      vitrinaPublicados,
      vitrinaProspectos,
      capitalLibre,
      capitalDisponible: capitalLibre === null ? null : config.capitalDisponible,
      desembolsado,
      ticketsAbiertos,
      vitrinaVisitasMes,
    },
    config: {
      valorAfianzamientoMensual: config.valorAfianzamientoMensual,
      ivaGarantiaPorcentaje: config.ivaGarantiaPorcentaje,
    },
    histSiniestralidad,
    contratosPorVencer: porVencer
      .sort((a, b) => (a.row.fecha_fin ?? '').localeCompare(b.row.fecha_fin ?? ''))
      .map((c) => ({
        id: c.row.id,
        inquilino: c.inq,
        inmueble: c.inm,
        mes: c.mes,
        fechaFin: c.row.fecha_fin,
        canon: c.canon,
      })),
    contratosZonaRiesgo: enRiesgo
      .sort((a, b) => a.mes - b.mes)
      .map((c) => ({
        id: c.row.id,
        inquilino: c.inq,
        inmueble: c.inm,
        mes: c.mes,
        fechaFin: c.row.fecha_fin,
        canon: c.canon,
      })),
    moraActiva: morasActivas
      .sort((a, b) => b.reportado_at.localeCompare(a.reportado_at))
      .map((m) => ({
        id: m.id,
        ticketNumero: m.ticket_numero,
        contratoId: m.contrato_id,
        inquilino: m.inquilino_nombre,
        inmueble: m.inmueble_direccion || m.inmueble_codigo || '—',
        fase: faseToNumber(m.estado),
        dias: Math.max(0, Math.floor((now.getTime() - new Date(m.reportado_at).getTime()) / 86_400_000)),
        monto: m.monto_mora ?? 0,
      })),
    actividadReciente: bitacora.map((b) => ({
      id: b.id,
      usuario: b.perfiles
        ? `${b.perfiles.nombre ?? ''} ${b.perfiles.apellido ?? ''}`.trim() || 'Sistema'
        : 'Sistema',
      accion: b.accion,
      entidad: b.entidad,
      fecha: b.created_at,
    })),
    meta: {
      // Si una métrica no tiene fuente (p. ej. capital sin configurar),
      // se reporta aquí para que el frontend la atenúe.
      metricasNoDisponibles: capitalLibre === null ? ['capital_libre'] : [],
    },
  };

  setCache(cacheKey, overview);
  return overview;
}

// ── Queries ──────────────────────────────────────────────────

async function fetchContratosActivos(): Promise<ContratoActivoRow[]> {
  const { data, error } = await supabase
    .from('contratos')
    .select(
      'id, estado, valor_arriendo, fecha_inicio, fecha_fin, expedientes(inmuebles(codigo, direccion), solicitantes(nombre, apellido))',
    )
    .in('estado', ESTADOS_CONTRATO_ACTIVO as unknown as string[]);

  if (error) throw fromSupabaseError(error);
  return (data ?? []) as unknown as ContratoActivoRow[];
}

// Contratos que alguna vez estuvieron activos (para el histórico de
// siniestralidad). Incluye finalizados/cancelados: su ventana
// fecha_inicio→fecha_fin determina en qué meses estuvieron vigentes.
async function fetchContratosHistorico(): Promise<Array<{ fecha_inicio: string | null; fecha_fin: string | null }>> {
  const { data, error } = await (
    supabase.from('contratos' as string) as ReturnType<typeof supabase.from>
  )
    .select('fecha_inicio, fecha_fin')
    .in('estado', ['firmado', 'vigente', 'finalizado', 'cancelado']);

  if (error) throw fromSupabaseError(error);
  return (data ?? []) as unknown as Array<{ fecha_inicio: string | null; fecha_fin: string | null }>;
}

async function fetchMoraTickets(): Promise<MoraTicketRow[]> {
  const { data, error } = await (
    supabase.from('moras_tickets' as string) as ReturnType<typeof supabase.from>
  )
    .select(
      'id, ticket_numero, contrato_id, monto_mora, estado, reportado_at, pagada_at, inquilino_nombre, inmueble_codigo, inmueble_direccion, cofianza_pago_realizado, cofianza_pago_monto, cofianza_pago_fecha',
    )
    .order('reportado_at', { ascending: false });

  if (error) throw fromSupabaseError(error);
  return (data ?? []) as unknown as MoraTicketRow[];
}

async function fetchBitacoraReciente(): Promise<BitacoraRow[]> {
  const { data, error } = await (
    supabase.from('bitacora' as string) as ReturnType<typeof supabase.from>
  )
    .select(
      'id, accion, entidad, created_at, perfiles!bitacora_usuario_id_fkey(nombre, apellido)',
    )
    .order('created_at', { ascending: false })
    .limit(8);

  if (error) throw fromSupabaseError(error);
  return (data ?? []) as unknown as BitacoraRow[];
}

async function fetchConfigDashboard(): Promise<AdminOverviewConfig & { capitalDisponible: number; reservaMinima: number }> {
  // Defaults alineados con los seeds de configuracion_sistema:
  //   valor_afianzamiento_mensual default 20000 (migración 20260427000004_contrato_template_data)
  //   iva_concepto_garantia default '0' / exento (migración 20260427000003_iva_por_concepto)
  const defaults = { valorAfianzamientoMensual: 20000, ivaGarantiaPorcentaje: 0, capitalDisponible: 0, reservaMinima: 0 };

  const { data } = await (
    supabase.from('configuracion_sistema' as string) as ReturnType<typeof supabase.from>
  )
    .select('clave, valor')
    .in('clave', [
      'valor_afianzamiento_mensual',
      'iva_concepto_garantia',
      'tesoreria_capital_disponible',
      'tesoreria_reserva_minima',
    ]);

  const rows = (data ?? []) as unknown as ConfiguracionRow[];
  const map: Record<string, string> = {};
  for (const r of rows) map[r.clave] = r.valor;

  return {
    valorAfianzamientoMensual: parseConfigNumber(map['valor_afianzamiento_mensual'], defaults.valorAfianzamientoMensual),
    ivaGarantiaPorcentaje: parseConfigNumber(map['iva_concepto_garantia'], defaults.ivaGarantiaPorcentaje),
    capitalDisponible: parseConfigNumber(map['tesoreria_capital_disponible'], defaults.capitalDisponible),
    reservaMinima: parseConfigNumber(map['tesoreria_reserva_minima'], defaults.reservaMinima),
  };
}

async function countInmobiliariasActivas(): Promise<number> {
  const { count, error } = await supabase
    .from('perfiles')
    .select('*', { count: 'exact', head: true })
    .eq('rol', 'inmobiliaria')
    .eq('estado', 'activo');

  if (error) throw fromSupabaseError(error);
  return count ?? 0;
}

async function countVitrinaPublicados(): Promise<number> {
  const { count, error } = await (
    supabase.from('inmuebles' as string) as ReturnType<typeof supabase.from>
  )
    .select('*', { count: 'exact', head: true })
    .eq('visible_vitrina', true);

  if (error) throw fromSupabaseError(error);
  return count ?? 0;
}

async function countVitrinaProspectos(): Promise<number> {
  const { count, error } = await (
    supabase.from('expedientes' as string) as ReturnType<typeof supabase.from>
  )
    .select('*', { count: 'exact', head: true })
    .eq('source', 'vitrina_publica')
    .neq('estado', 'cerrado');

  if (error) throw fromSupabaseError(error);
  return count ?? 0;
}

async function countVitrinaVisitasMes(): Promise<number> {
  // Inicio de mes anclado a hora Colombia (no a la hora local del servidor,
  // que en Railway/Render es UTC). created_at es TIMESTAMPTZ.
  const { year, month0 } = bogotaYearMonth(new Date());
  const inicioMes = bogotaMonthStartUtc(year, month0);

  const { count, error } = await (
    supabase.from('vitrina_interacciones' as string) as ReturnType<typeof supabase.from>
  )
    .select('*', { count: 'exact', head: true })
    .eq('tipo', 'vista')
    .gte('created_at', inicioMes.toISOString());

  if (error) throw fromSupabaseError(error);
  return count ?? 0;
}

async function countTicketsAbiertos(): Promise<number> {
  const { count, error } = await (
    supabase.from('tickets_soporte' as string) as ReturnType<typeof supabase.from>
  )
    .select('*', { count: 'exact', head: true })
    .neq('estado', 'resuelto');

  if (error) throw fromSupabaseError(error);
  return count ?? 0;
}

// ── Helpers de cálculo ──────────────────────────────────────

function parseConfigNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function mesesTranscurridos(fechaInicio: string | null, now: Date): number {
  if (!fechaInicio) return 0;
  const ini = new Date(fechaInicio);
  if (Number.isNaN(ini.getTime())) return 0;
  return (now.getFullYear() - ini.getFullYear()) * 12 + (now.getMonth() - ini.getMonth());
}

function isPorVencer(fechaFin: string | null, now: Date): boolean {
  if (!fechaFin) return false;
  const fin = new Date(fechaFin);
  if (Number.isNaN(fin.getTime())) return false;
  const diffDias = Math.floor((fin.getTime() - now.getTime()) / 86_400_000);
  return diffDias >= 0 && diffDias <= POR_VENCER_DIAS;
}

function isRiskMes(mes: number): boolean {
  return mes >= 8 && mes <= 14;
}

// ── Helpers de zona horaria (Colombia = America/Bogota, UTC-5 fijo, sin DST) ──
//
// Los conteos por mes (visitas vitrina, moras del histórico) comparan contra
// columnas TIMESTAMPTZ (UTC). Anclamos los límites de mes a la medianoche de
// Bogotá para que un evento de las 23:00 hora Colombia del último día del mes
// no se cuente en el mes siguiente (lo que pasaría si el servidor corre en UTC).
const BOGOTA_OFFSET_MS = 5 * 60 * 60 * 1000;

/** Año y mes (0-11) del instante `now` expresados en hora Colombia. */
function bogotaYearMonth(now: Date): { year: number; month0: number } {
  const bogota = new Date(now.getTime() - BOGOTA_OFFSET_MS);
  return { year: bogota.getUTCFullYear(), month0: bogota.getUTCMonth() };
}

/** Instante UTC de la medianoche en Bogotá del 1° del mes (year, month0). */
function bogotaMonthStartUtc(year: number, month0: number): Date {
  // Medianoche Bogotá = 05:00 UTC. Date.UTC normaliza desbordes de mes/año.
  return new Date(Date.UTC(year, month0, 1, 5, 0, 0));
}

function faseToNumber(estado: string): number {
  if (estado === 'fase_1') return 1;
  if (estado === 'fase_2') return 2;
  if (estado === 'fase_3') return 3;
  return 0;
}

function formatInquilino(s: { nombre: string | null; apellido: string | null } | null): string {
  if (!s) return '—';
  return `${s.nombre ?? ''} ${s.apellido ?? ''}`.trim() || '—';
}

function formatInmueble(i: { codigo: string | null; direccion: string | null } | null): string {
  if (!i) return '—';
  if (i.codigo && i.direccion) return `${i.codigo} ${i.direccion}`;
  return i.codigo || i.direccion || '—';
}

/**
 * Para los últimos 6 meses (incluido el actual), calcula la siniestralidad
 * como `moras_reportadas_en_el_mes / contratos_activos_durante_el_mes`.
 *
 * "Activo durante el mes" = contrato con fecha_inicio anterior al final del
 * mes y (fecha_fin nula OR posterior al inicio del mes). `contratos` incluye
 * los que alguna vez estuvieron activos (firmado/vigente/finalizado/cancelado)
 * para no subestimar el denominador de meses pasados. Sigue siendo una
 * aproximación (no hay snapshot diario) pero coherente entre numerador y
 * denominador. Los límites de mes se anclan a hora Colombia.
 */
function calcularHistoricoSiniestralidad(
  contratos: Array<{ fecha_inicio: string | null; fecha_fin: string | null }>,
  moras: Array<{ reportado_at: string }>,
  now: Date,
): AdminOverviewHistItem[] {
  const meses: AdminOverviewHistItem[] = [];
  const { year, month0 } = bogotaYearMonth(now);

  for (let offset = 5; offset >= 0; offset--) {
    const inicioMes = bogotaMonthStartUtc(year, month0 - offset);
    // Fin de mes = 1 ms antes del inicio del mes siguiente.
    const finMes = new Date(bogotaMonthStartUtc(year, month0 - offset + 1).getTime() - 1);
    const label = new Intl.DateTimeFormat('es-CO', {
      timeZone: 'America/Bogota',
      month: 'short',
      year: '2-digit',
    }).format(inicioMes);

    const activos = contratos.filter((c) => {
      if (!c.fecha_inicio) return false;
      const ini = new Date(c.fecha_inicio).getTime();
      if (ini > finMes.getTime()) return false;
      if (!c.fecha_fin) return true;
      return new Date(c.fecha_fin).getTime() >= inicioMes.getTime();
    }).length;

    const morasMes = moras.filter((m) => {
      const t = new Date(m.reportado_at).getTime();
      return t >= inicioMes.getTime() && t <= finMes.getTime();
    }).length;

    const r = activos ? Math.round((morasMes / activos) * 1000) / 10 : 0;
    meses.push({ mes: capitalize(label.replace('.', '')), ct: activos, mr: morasMes, r });
  }
  return meses;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Tesorería (config editable por admin) ───────────────────
//
// Lee/escribe las dos claves de configuracion_sistema que alimentan el KPI
// "Capital libre" del Centro de Control. Permite al admin configurarlas desde
// /configuracion sin tocar SQL.

export interface TesoreriaConfig {
  capitalDisponible: number;
  reservaMinima: number;
}

export async function getTesoreria(): Promise<TesoreriaConfig> {
  const { data, error } = await (
    supabase.from('configuracion_sistema' as string) as ReturnType<typeof supabase.from>
  )
    .select('clave, valor')
    .in('clave', ['tesoreria_capital_disponible', 'tesoreria_reserva_minima']);

  if (error) throw fromSupabaseError(error);

  const map: Record<string, string> = {};
  for (const r of (data ?? []) as unknown as ConfiguracionRow[]) map[r.clave] = r.valor;

  return {
    capitalDisponible: parseConfigNumber(map['tesoreria_capital_disponible'], 0),
    reservaMinima: parseConfigNumber(map['tesoreria_reserva_minima'], 0),
  };
}

export async function updateTesoreria(input: TesoreriaConfig): Promise<TesoreriaConfig> {
  // Upsert por clave (UNIQUE). Guardamos como string porque la columna valor es TEXT.
  const rows = [
    { clave: 'tesoreria_capital_disponible', valor: String(Math.round(input.capitalDisponible)), tipo: 'number' },
    { clave: 'tesoreria_reserva_minima', valor: String(Math.round(input.reservaMinima)), tipo: 'number' },
  ];

  const { error } = await (
    supabase.from('configuracion_sistema' as string) as ReturnType<typeof supabase.from>
  ).upsert(rows, { onConflict: 'clave' });

  if (error) throw fromSupabaseError(error);

  // El Centro de Control cachea el overview 5min; invalidar para que el cambio
  // se refleje de inmediato en el KPI "Capital libre".
  cache.delete('admin-overview');

  return {
    capitalDisponible: Math.round(input.capitalDisponible),
    reservaMinima: Math.round(input.reservaMinima),
  };
}
