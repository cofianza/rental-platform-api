import { Request, Response } from 'express';
import { sendSuccess } from '@/lib/response';
import * as service from './invitacion.service';
import type { TokenParam } from './invitacion.schema';

export async function getInvitacion(req: Request, res: Response) {
  const { token } = req.params as unknown as TokenParam;
  const info = await service.getInvitacionPublic(token);
  sendSuccess(res, info);
}

export async function canjearInvitacion(req: Request, res: Response) {
  const { token } = req.params as unknown as TokenParam;
  const result = await service.canjearInvitacion(token, req.user!);
  sendSuccess(res, result);
}
