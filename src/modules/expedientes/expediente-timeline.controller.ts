import { Request, Response } from 'express';
import { sendSuccess } from '@/lib/response';
import { getUnifiedTimeline } from './expediente-timeline.service';
import type { ExpedienteIdParams } from './expediente-workflow.schema';
import type { TimelineQuery } from './expediente-timeline.schema';

export async function getTimeline(req: Request, res: Response) {
  const { id } = req.params as unknown as ExpedienteIdParams;
  const query = req.query as unknown as TimelineQuery;
  const { eventos, pagination } = await getUnifiedTimeline(id, query);
  sendSuccess(res, eventos, 200, pagination);
}
