import { Request, Response } from 'express';
import { sendSuccess } from '@/lib/response';
import * as workflowService from './expediente-workflow.service';
import type { TransitionInput, ExpedienteIdParams } from './expediente-workflow.schema';

export async function transition(req: Request, res: Response) {
  const { id } = req.params as unknown as ExpedienteIdParams;
  const input = req.body as TransitionInput;
  const result = await workflowService.executeTransition(id, input, req.user!);
  sendSuccess(res, result);
}

export async function cerrarSinActa(req: Request, res: Response) {
  const { id } = req.params as unknown as ExpedienteIdParams;
  const { motivo } = req.body as { motivo: string };
  const result = await workflowService.cerrarSinActa(id, motivo, req.user!, req.ip);
  sendSuccess(res, result);
}

export async function getAvailableTransitions(req: Request, res: Response) {
  const { id } = req.params as unknown as ExpedienteIdParams;
  const result = await workflowService.getTransitionsForExpediente(id, req.user?.id, req.user?.rol);
  sendSuccess(res, result);
}

export async function getHistory(req: Request, res: Response) {
  const { id } = req.params as unknown as ExpedienteIdParams;
  const result = await workflowService.getTransitionHistory(id, req.user?.id, req.user?.rol);
  sendSuccess(res, result);
}
