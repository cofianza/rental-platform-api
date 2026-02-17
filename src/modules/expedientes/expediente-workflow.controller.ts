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

export async function getTransitions(req: Request, res: Response) {
  const { id } = req.params as unknown as ExpedienteIdParams;
  const result = await workflowService.getTransitionsForExpediente(id, req.user!);
  sendSuccess(res, result);
}
