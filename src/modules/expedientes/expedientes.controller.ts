import { Request, Response } from 'express';
import { sendSuccess, sendCreated } from '@/lib/response';
import * as expedientesService from './expedientes.service';
import type {
  ListExpedientesQuery,
  CreateExpedienteInput,
  UpdateExpedienteInput,
} from './expedientes.schema';
import type { ExpedienteIdParams } from './expediente-workflow.schema';

export async function list(req: Request, res: Response) {
  const query = req.query as unknown as ListExpedientesQuery;
  const result = await expedientesService.listExpedientes(query);
  sendSuccess(res, result.expedientes, 200, result.pagination);
}

export async function getById(req: Request, res: Response) {
  const { id } = req.params as unknown as ExpedienteIdParams;
  const expediente = await expedientesService.getExpedienteById(id);
  sendSuccess(res, expediente);
}

export async function create(req: Request, res: Response) {
  const input = req.body as CreateExpedienteInput;
  const expediente = await expedientesService.createExpediente(input, req.user!.id, req.ip);
  sendCreated(res, expediente);
}

export async function update(req: Request, res: Response) {
  const { id } = req.params as unknown as ExpedienteIdParams;
  const input = req.body as UpdateExpedienteInput;
  const expediente = await expedientesService.updateExpediente(id, input, req.user!.id, req.ip);
  sendSuccess(res, expediente);
}

export async function stats(_req: Request, res: Response) {
  const result = await expedientesService.getExpedienteStats();
  sendSuccess(res, result);
}
