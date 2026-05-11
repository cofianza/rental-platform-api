import { Request, Response } from 'express';
import { sendSuccess } from '@/utils/response';
import * as auditoriaService from './expediente-auditoria.service';

export async function getAuditoriaScore(req: Request, res: Response) {
  const { id } = req.params as { id: string };
  const reporte = await auditoriaService.getAuditoriaScore(id);
  sendSuccess(res, reporte);
}
