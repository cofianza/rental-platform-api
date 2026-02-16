import { Request, Response, NextFunction } from 'express';
import { logger } from '@/lib/logger';
import { env } from '@/config/env';
import { AppError } from '@/lib/errors';

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
    });
    return;
  }

  // Error de Supabase/PostgreSQL
  if ('code' in err && typeof (err as Record<string, unknown>).code === 'string') {
    const pgCode = (err as Record<string, unknown>).code as string;
    const mapped = mapPostgresError(pgCode, err.message);
    logger.warn({ pgCode }, err.message);
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

function mapPostgresError(code: string, originalMessage: string) {
  switch (code) {
    case '23505': // unique_violation
      return { statusCode: 409, errorCode: 'DUPLICATE', message: 'El registro ya existe' };
    case '23503': // foreign_key_violation
      return { statusCode: 400, errorCode: 'FK_VIOLATION', message: 'Referencia a registro inexistente' };
    case '23502': // not_null_violation
      return { statusCode: 400, errorCode: 'REQUIRED_FIELD', message: 'Campo requerido faltante' };
    case 'PGRST116': // Supabase: row not found
      return { statusCode: 404, errorCode: 'NOT_FOUND', message: 'Recurso no encontrado' };
    default:
      return { statusCode: 500, errorCode: 'DB_ERROR', message: originalMessage };
  }
}
