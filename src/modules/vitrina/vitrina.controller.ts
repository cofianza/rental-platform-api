// ============================================================
// Vitrina Publica — Controller (HP-368)
// ============================================================

import { Request, Response } from 'express';
import { sendSuccess } from '@/utils/response';
import * as service from './vitrina.service';
import type { RegisterSolicitanteInput, InterestInput } from './vitrina.schema';

export async function registerSolicitante(req: Request, res: Response) {
  const input = req.body as RegisterSolicitanteInput;

  const result = await service.registerSolicitante(input);

  sendSuccess(res, result, undefined, 201);
}

export async function createInterest(req: Request, res: Response) {
  const userId = req.user!.id;
  const { property_id } = req.body as InterestInput;

  const result = await service.createInterest(userId, property_id);

  sendSuccess(res, result, undefined, 201);
}
