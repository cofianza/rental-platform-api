import { Request, Response } from 'express';
import { sendCreated, sendSuccess } from '@/lib/response';
import * as assignmentsService from './expediente-assignments.service';
import type { ExpedienteIdParams } from './expediente-workflow.schema';
import type { AssignBodyInput } from './expediente-assignments.schema';

export async function assign(req: Request, res: Response) {
  const { id } = req.params as unknown as ExpedienteIdParams;
  const { analista_id } = req.body as AssignBodyInput;
  const result = await assignmentsService.assignResponsable(
    id,
    analista_id,
    req.user!.id,
    req.user!.email,
    req.ip,
  );
  sendCreated(res, result);
}

export async function history(req: Request, res: Response) {
  const { id } = req.params as unknown as ExpedienteIdParams;
  const result = await assignmentsService.getAssignmentHistory(id);
  sendSuccess(res, result);
}
