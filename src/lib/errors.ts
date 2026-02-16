import type { PostgrestError } from '@supabase/supabase-js';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly errorCode: string;
  public readonly details?: unknown;

  constructor(statusCode: number, errorCode: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.details = details;
    Object.setPrototypeOf(this, AppError.prototype);
  }

  static badRequest(message: string, errorCode = 'BAD_REQUEST', details?: unknown) {
    return new AppError(400, errorCode, message, details);
  }

  static unauthorized(message = 'No autenticado', errorCode = 'UNAUTHORIZED') {
    return new AppError(401, errorCode, message);
  }

  static forbidden(message = 'Sin permisos', errorCode = 'FORBIDDEN') {
    return new AppError(403, errorCode, message);
  }

  static notFound(message = 'Recurso no encontrado', errorCode = 'NOT_FOUND') {
    return new AppError(404, errorCode, message);
  }

  static conflict(message: string, errorCode = 'CONFLICT') {
    return new AppError(409, errorCode, message);
  }

  static tooMany(message = 'Demasiadas solicitudes', errorCode = 'TOO_MANY_REQUESTS') {
    return new AppError(429, errorCode, message);
  }
}

const PG_ERROR_MAP: Record<string, { statusCode: number; errorCode: string; message: string }> = {
  '23505': { statusCode: 409, errorCode: 'DUPLICATE_ENTRY', message: 'El registro ya existe' },
  '23503': { statusCode: 400, errorCode: 'FK_VIOLATION', message: 'Referencia a registro inexistente' },
  '23502': { statusCode: 400, errorCode: 'NOT_NULL_VIOLATION', message: 'Campo requerido faltante' },
  PGRST116: { statusCode: 404, errorCode: 'NOT_FOUND', message: 'Recurso no encontrado' },
  '42501': { statusCode: 403, errorCode: 'INSUFFICIENT_PRIVILEGE', message: 'Privilegios insuficientes' },
};

export function fromSupabaseError(error: PostgrestError): AppError {
  const mapped = PG_ERROR_MAP[error.code];
  if (mapped) {
    return new AppError(mapped.statusCode, mapped.errorCode, mapped.message, {
      hint: error.hint,
      details: error.details,
    });
  }
  return new AppError(500, 'DATABASE_ERROR', error.message);
}
