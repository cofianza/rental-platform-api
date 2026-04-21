import { Request, Response } from 'express';
import { sendSuccess } from '@/lib/response';
import * as service from './expediente-habilitacion.service';
import type { ExpedienteIdParams } from './expedientes.schema';

export async function habilitarEstudio(req: Request, res: Response) {
  const { id } = req.params as unknown as ExpedienteIdParams;
  const result = await service.habilitarEstudio(id, req.user!.id, req.user!.rol);
  sendSuccess(res, result);
}
