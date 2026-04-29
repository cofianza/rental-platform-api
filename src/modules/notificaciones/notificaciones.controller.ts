import { Request, Response } from 'express';
import { sendSuccess } from '@/lib/response';
import { buildPaginationMeta } from '@/utils/pagination';
import * as service from './notificaciones.service';
import type { ListNotificacionesQuery, NotificacionIdParams } from './notificaciones.schema';

export async function list(req: Request, res: Response) {
  const userId = req.user!.id;
  const query = req.query as unknown as ListNotificacionesQuery;
  const result = await service.listMisNotificaciones(userId, {
    page: query.page,
    limit: query.limit,
    soloNoLeidas: query.solo_no_leidas,
  });
  sendSuccess(res, result.data, 200, buildPaginationMeta(result.total, result.page, result.limit));
}

export async function getUnreadCount(_req: Request, res: Response) {
  const userId = _req.user!.id;
  const count = await service.contarNoLeidas(userId);
  sendSuccess(res, { count });
}

export async function markAsRead(req: Request, res: Response) {
  const userId = req.user!.id;
  const { id } = req.params as unknown as NotificacionIdParams;
  const updated = await service.marcarLeida(id, userId);
  sendSuccess(res, updated);
}

export async function markAllAsRead(req: Request, res: Response) {
  const userId = req.user!.id;
  const result = await service.marcarTodasLeidas(userId);
  sendSuccess(res, result);
}
