import { Request, Response, NextFunction } from 'express';
import { logger } from '@/lib/logger';
import { env } from '@/config/env';
import { AppError, fromSupabaseError } from '@/lib/errors';

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  const isDev = env.NODE_ENV !== 'production';

  // AppError: errores controlados con codigo HTTP especifico
  if (err instanceof AppError) {
    logger.warn({ errorCode: err.errorCode, statusCode: err.statusCode }, err.message);
    res.status(err.statusCode).json({
      success: false,
      errorCode: err.errorCode,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
      ...(isDev && { stack: err.stack }),
    });
    return;
  }

  // Error de Supabase/PostgreSQL
  if ('code' in err && typeof (err as Record<string, unknown>).code === 'string') {
    const supabaseErr = err as unknown as { code: string; message: string; hint?: string; details?: string };
    const mapped = fromSupabaseError(supabaseErr as Parameters<typeof fromSupabaseError>[0]);
    logger.warn({ pgCode: supabaseErr.code }, err.message);
    res.status(mapped.statusCode).json({
      success: false,
      errorCode: mapped.errorCode,
      message: mapped.message,
    });
    return;
  }

  // Error no controlado
  logger.error({ err }, err.message);
  res.status(500).json({
    success: false,
    errorCode: 'INTERNAL_ERROR',
    message: isDev ? err.message : 'Error interno del servidor',
    ...(isDev && { stack: err.stack }),
  });
}
