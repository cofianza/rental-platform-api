import { Request, Response, NextFunction } from 'express';
import { logger } from '@/lib/logger';
import { env } from '@/config/env';

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  logger.error({ err }, err.message);

  const isDev = env.NODE_ENV !== 'production';

  res.status(500).json({
    success: false,
    message: isDev ? err.message : 'Internal Server Error',
    ...(isDev && { stack: err.stack }),
  });
}
