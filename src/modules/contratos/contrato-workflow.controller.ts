import { Request, Response } from 'express';
import { sendSuccess } from '@/lib/response';
import * as workflowService from './contrato-workflow.service';
import type { ContratoTransitionInput } from './contrato-workflow.schema';
import type { ContratoIdParams } from './contratos.schema';

export async function transition(req: Request, res: Response) {
  const { id } = req.params as unknown as ContratoIdParams;
  const input = req.body as ContratoTransitionInput;
  const result = await workflowService.executeContratoTransition(id, input, req.user!);
  sendSuccess(res, result);
}

export async function getAvailableTransitions(req: Request, res: Response) {
  const { id } = req.params as unknown as ContratoIdParams;
  const result = await workflowService.getContratoTransitions(id);
  sendSuccess(res, result);
}

export async function getHistory(req: Request, res: Response) {
  const { id } = req.params as unknown as ContratoIdParams;
  const result = await workflowService.getContratoTransitionHistory(id);
  sendSuccess(res, result);
}
