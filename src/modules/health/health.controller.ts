import { Request, Response } from 'express';
import { getHealthStatus } from './health.service';
import { sendSuccess } from '@/utils/response';

export async function getHealth(_req: Request, res: Response): Promise<void> {
  const health = await getHealthStatus();
  sendSuccess(res, health);
}
