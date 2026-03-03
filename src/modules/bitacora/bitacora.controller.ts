import { Request, Response } from 'express';
import { sendSuccess } from '@/lib/response';
import * as bitacoraService from './bitacora.service';
import type { ListAuditLogsQuery, AuditLogIdParams } from './bitacora.schema';

export async function list(req: Request, res: Response) {
  const query = req.query as unknown as ListAuditLogsQuery;
  const result = await bitacoraService.listAuditLogs(query);
  sendSuccess(res, result.logs, 200, result.pagination);
}

export async function getById(req: Request, res: Response) {
  const { id } = req.params as unknown as AuditLogIdParams;
  const log = await bitacoraService.getAuditLogById(id);
  sendSuccess(res, log);
}

export async function stats(_req: Request, res: Response) {
  const result = await bitacoraService.getAuditStats();
  sendSuccess(res, result);
}
