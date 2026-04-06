// ============================================================
// Reportes — Controller (HP-360)
// ============================================================

import { Request, Response } from 'express';
import { sendSuccess } from '@/utils/response';
import * as reportesService from './reportes.service';
import type { VolumenQuery, AprobacionQuery, IngresosQuery, TiemposQuery } from './reportes.schema';

const CACHE_CONTROL_HEADER = 'public, max-age=300'; // 5 minutes

export async function getVolumenExpedientes(req: Request, res: Response) {
  const query = (req as Request & { validatedQuery: VolumenQuery }).validatedQuery || req.query;
  const { dateFrom, dateTo, estado } = query as VolumenQuery;

  const data = await reportesService.getVolumenExpedientes(dateFrom, dateTo, estado);

  res.set('Cache-Control', CACHE_CONTROL_HEADER);
  sendSuccess(res, data);
}

// HP-361
export async function getAprobacionExpedientes(req: Request, res: Response) {
  const query = (req as Request & { validatedQuery: AprobacionQuery }).validatedQuery || req.query;
  const { dateFrom, dateTo } = query as AprobacionQuery;

  const data = await reportesService.getAprobacionExpedientes(dateFrom, dateTo);

  res.set('Cache-Control', CACHE_CONTROL_HEADER);
  sendSuccess(res, data);
}

// HP-362
export async function getIngresosReporte(req: Request, res: Response) {
  const query = (req as Request & { validatedQuery: IngresosQuery }).validatedQuery || req.query;
  const { dateFrom, dateTo, concepto } = query as IngresosQuery;

  const data = await reportesService.getIngresosReporte(dateFrom, dateTo, concepto);

  res.set('Cache-Control', CACHE_CONTROL_HEADER);
  sendSuccess(res, data);
}

// HP-363
export async function getTiemposPorEtapa(req: Request, res: Response) {
  const query = (req as Request & { validatedQuery: TiemposQuery }).validatedQuery || req.query;
  const { dateFrom, dateTo } = query as TiemposQuery;

  const data = await reportesService.getTiemposPorEtapa(dateFrom, dateTo);

  res.set('Cache-Control', CACHE_CONTROL_HEADER);
  sendSuccess(res, data);
}
