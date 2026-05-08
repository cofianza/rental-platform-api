// ============================================================
// Admin Tools — Controller (TEMPORAL)
// ============================================================

import { Request, Response } from 'express';
import { sendSuccess } from '@/utils/response';
import * as adminToolsService from './admin-tools.service';

export async function wipeTestData(req: Request, res: Response) {
  const confirm = (req.body?.confirm ?? '') as string;
  const user = req.user!;
  const result = await adminToolsService.wipeTestData(confirm, {
    id: user.id,
    email: user.email,
  });
  sendSuccess(res, result);
}
