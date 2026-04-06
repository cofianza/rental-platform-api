// ============================================================
// Export — Controller (HP-364)
// ============================================================

import { Request, Response } from 'express';
import { supabase } from '@/lib/supabase';
import { fromSupabaseError } from '@/lib/errors';
import * as reportesService from '@/modules/reportes/reportes.service';
import { generateCSV, generateXLSX, type ExportColumn } from './export.service';
import type { ExportQuery } from './export.schema';

// ── Helper: send export result ──────────────────────────────

function sendExport(res: Response, result: Awaited<ReturnType<typeof generateCSV>>) {
  res.set('Content-Type', result.contentType);
  res.set('Content-Disposition', `attachment; filename="${result.filename}"`);
  res.set('X-Export-Truncated', String(result.truncated));
  res.set('X-Export-Total-Rows', String(result.totalRows));
  res.send(result.buffer);
}

function getQuery(req: Request): ExportQuery {
  return ((req as Request & { validatedQuery: ExportQuery }).validatedQuery || req.query) as ExportQuery;
}

// ── Expedientes ─────────────────────────────────────────────

const EXPEDIENTE_COLS: ExportColumn[] = [
  { header: 'Numero', key: 'numero', width: 16 },
  { header: 'Solicitante', key: 'solicitante_nombre', width: 28 },
  { header: 'Inmueble', key: 'inmueble_direccion', width: 32 },
  { header: 'Estado', key: 'estado', width: 16 },
  { header: 'Fecha Creacion', key: 'created_at', width: 16, isDate: true },
  { header: 'Analista', key: 'analista_nombre', width: 24 },
];

export async function exportExpedientes(req: Request, res: Response) {
  const q = getQuery(req);

  let qb = supabase
    .from('expedientes')
    .select('numero, estado, created_at, solicitantes(nombre, apellido), inmuebles(direccion), perfiles!expedientes_analista_id_fkey(nombre, apellido)')
    .order('created_at', { ascending: false })
    .limit(10500);

  if (q.estado) qb = qb.eq('estado', q.estado);
  if (q.fecha_desde) qb = qb.gte('created_at', q.fecha_desde);
  if (q.fecha_hasta) qb = qb.lte('created_at', q.fecha_hasta);

  const { data, error } = await qb;
  if (error) throw fromSupabaseError(error);

  const rows = (data ?? []).map((r: Record<string, unknown>) => {
    const sol = r.solicitantes as Record<string, string> | null;
    const inm = r.inmuebles as Record<string, string> | null;
    const ana = r['perfiles!expedientes_analista_id_fkey'] as Record<string, string> | null;
    return {
      numero: r.numero,
      solicitante_nombre: sol ? `${sol.nombre} ${sol.apellido}` : '',
      inmueble_direccion: inm?.direccion ?? '',
      estado: r.estado,
      created_at: r.created_at,
      analista_nombre: ana ? `${ana.nombre} ${ana.apellido}` : '',
    };
  });

  const result = q.format === 'xlsx'
    ? await generateXLSX(EXPEDIENTE_COLS, rows, 'expedientes', 'Expedientes')
    : generateCSV(EXPEDIENTE_COLS, rows, 'expedientes');

  sendExport(res, result);
}

// ── Inmuebles ───────────────────────────────────────────────

const INMUEBLE_COLS: ExportColumn[] = [
  { header: 'Codigo', key: 'codigo', width: 12 },
  { header: 'Direccion', key: 'direccion', width: 32 },
  { header: 'Ciudad', key: 'ciudad', width: 16 },
  { header: 'Tipo', key: 'tipo', width: 14 },
  { header: 'Estado', key: 'estado', width: 14 },
  { header: 'Valor Arriendo', key: 'valor_arriendo', width: 18, isCurrency: true },
];

export async function exportInmuebles(req: Request, res: Response) {
  const q = getQuery(req);

  let qb = supabase
    .from('inmuebles')
    .select('codigo, direccion, ciudad, tipo, estado, valor_arriendo')
    .order('created_at', { ascending: false })
    .limit(10500);

  if (q.estado) qb = qb.eq('estado', q.estado);
  if (q.tipo) qb = qb.eq('tipo', q.tipo);
  if (q.ciudad) qb = qb.ilike('ciudad', q.ciudad);

  const { data, error } = await qb;
  if (error) throw fromSupabaseError(error);

  const rows = (data ?? []) as Record<string, unknown>[];
  const result = q.format === 'xlsx'
    ? await generateXLSX(INMUEBLE_COLS, rows, 'inmuebles', 'Inmuebles')
    : generateCSV(INMUEBLE_COLS, rows, 'inmuebles');

  sendExport(res, result);
}

// ── Reporte: Volumen ────────────────────────────────────────

const VOLUMEN_COLS: ExportColumn[] = [
  { header: 'Periodo', key: 'periodo', width: 18 },
  { header: 'Creados', key: 'creados', width: 12 },
  { header: 'Cerrados', key: 'cerrados', width: 12 },
  { header: 'Neto', key: 'neto', width: 12 },
];

export async function exportVolumen(req: Request, res: Response) {
  const q = getQuery(req);
  const data = await reportesService.getVolumenExpedientes(q.dateFrom, q.dateTo, q.estado);
  const rows = data.meses as unknown as Record<string, unknown>[];

  const result = q.format === 'xlsx'
    ? await generateXLSX(VOLUMEN_COLS, rows, 'volumen_expedientes', 'Volumen')
    : generateCSV(VOLUMEN_COLS, rows, 'volumen_expedientes');

  sendExport(res, result);
}

// ── Reporte: Aprobacion ─────────────────────────────────────

const APROBACION_COLS: ExportColumn[] = [
  { header: 'Periodo', key: 'periodo', width: 18 },
  { header: 'Aprobados', key: 'aprobados', width: 12 },
  { header: 'Rechazados', key: 'rechazados', width: 12 },
  { header: 'Condicionados', key: 'condicionados', width: 14 },
  { header: 'Total', key: 'total', width: 10 },
  { header: 'Tasa (%)', key: 'tasa', width: 12 },
];

export async function exportAprobacion(req: Request, res: Response) {
  const q = getQuery(req);
  const data = await reportesService.getAprobacionExpedientes(q.dateFrom, q.dateTo);
  const rows = data.meses as unknown as Record<string, unknown>[];

  const result = q.format === 'xlsx'
    ? await generateXLSX(APROBACION_COLS, rows, 'aprobacion', 'Aprobacion')
    : generateCSV(APROBACION_COLS, rows, 'aprobacion');

  sendExport(res, result);
}

// ── Reporte: Ingresos ───────────────────────────────────────

const INGRESOS_COLS: ExportColumn[] = [
  { header: 'Periodo', key: 'periodo', width: 18 },
  { header: 'Concepto', key: 'concepto', width: 16 },
  { header: '# Pagos', key: 'cantidad_pagos', width: 10 },
  { header: 'Monto Total', key: 'monto_total', width: 18, isCurrency: true },
];

export async function exportIngresos(req: Request, res: Response) {
  const q = getQuery(req);
  const data = await reportesService.getIngresosReporte(q.dateFrom, q.dateTo, q.concepto);
  const rows = data.meses as unknown as Record<string, unknown>[];

  const result = q.format === 'xlsx'
    ? await generateXLSX(INGRESOS_COLS, rows, 'ingresos', 'Ingresos')
    : generateCSV(INGRESOS_COLS, rows, 'ingresos');

  sendExport(res, result);
}

// ── Reporte: Tiempos ────────────────────────────────────────

const TIEMPOS_COLS: ExportColumn[] = [
  { header: 'Etapa', key: 'etapa', width: 20 },
  { header: 'Promedio (dias)', key: 'promedio_dias', width: 16 },
  { header: 'Minimo (dias)', key: 'minimo_dias', width: 14 },
  { header: 'Maximo (dias)', key: 'maximo_dias', width: 14 },
  { header: '# Expedientes', key: 'cantidad_expedientes', width: 14 },
  { header: 'Cuello Botella', key: 'es_cuello_botella', width: 16 },
];

export async function exportTiempos(req: Request, res: Response) {
  const q = getQuery(req);
  const data = await reportesService.getTiemposPorEtapa(q.dateFrom, q.dateTo);
  const rows = data.etapas.map((e) => ({
    ...e,
    es_cuello_botella: e.es_cuello_botella ? 'Si' : 'No',
  })) as unknown as Record<string, unknown>[];

  const result = q.format === 'xlsx'
    ? await generateXLSX(TIEMPOS_COLS, rows, 'tiempos_etapa', 'Tiempos')
    : generateCSV(TIEMPOS_COLS, rows, 'tiempos_etapa');

  sendExport(res, result);
}
