import { Request, Response, NextFunction } from 'express';
import { logger } from '@/lib/logger';
import { env } from '@/config/env';
import { AppError } from '@/lib/errors';

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const isDev = env.NODE_ENV !== 'production';

  if (err instanceof AppError) {
    logger.warn({ err, statusCode: err.statusCode, errorCode: err.errorCode }, err.message);

    res.status(err.statusCode).json({
      success: false,
      errorCode: err.errorCode,
      message: err.message,
      ...(err.details !== undefined && { details: err.details }),
      ...(isDev && { stack: err.stack }),
    });
    return;
  }

  logger.error({ err }, err.message);

  res.status(500).json({
    success: false,
    errorCode: 'INTERNAL_ERROR',
    message: isDev ? err.message : 'Internal Server Error',
    ...(isDev && { stack: err.stack }),
  });
}
