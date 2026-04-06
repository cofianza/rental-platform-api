// ============================================================
// Dashboard — Controller (HP-358)
// ============================================================

import { Request, Response } from 'express';
import { sendSuccess } from '@/utils/response';
import * as dashboardService from './dashboard.service';
import type { DashboardQuery } from './dashboard.schema';

const CACHE_CONTROL_HEADER = 'public, max-age=300'; // 5 minutes

export async function getSummary(req: Request, res: Response) {
  const query = (req as Request & { validatedQuery: DashboardQuery }).validatedQuery || req.query;
  const { dateFrom, dateTo } = query as DashboardQuery;

  const summary = await dashboardService.getSummary(dateFrom, dateTo);

  res.set('Cache-Control', CACHE_CONTROL_HEADER);
  sendSuccess(res, summary);
}

export async function getExpedientesPorEstado(req: Request, res: Response) {
  const query = (req as Request & { validatedQuery: DashboardQuery }).validatedQuery || req.query;
  const { dateFrom, dateTo } = query as DashboardQuery;

  const data = await dashboardService.getExpedientesPorEstado(dateFrom, dateTo);

  res.set('Cache-Control', CACHE_CONTROL_HEADER);
  sendSuccess(res, data);
}
