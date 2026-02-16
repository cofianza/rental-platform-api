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

  // Factory methods for common HTTP errors
  static badRequest(message: string, details?: unknown): AppError {
    return new AppError(400, 'BAD_REQUEST', message, details);
  }

  static unauthorized(message: string = 'Unauthorized', details?: unknown): AppError {
    return new AppError(401, 'UNAUTHORIZED', message, details);
  }

  static forbidden(message: string = 'Forbidden', details?: unknown): AppError {
    return new AppError(403, 'FORBIDDEN', message, details);
  }

  static notFound(message: string = 'Resource not found', details?: unknown): AppError {
    return new AppError(404, 'NOT_FOUND', message, details);
  }

  static conflict(message: string, details?: unknown): AppError {
    return new AppError(409, 'CONFLICT', message, details);
  }
}

const PG_ERROR_MAP: Record<string, { statusCode: number; errorCode: string; message: string }> = {
  '23505': { statusCode: 409, errorCode: 'DUPLICATE_ENTRY', message: 'Resource already exists' },
  '23503': {
    statusCode: 400,
    errorCode: 'FK_VIOLATION',
    message: 'Referenced resource does not exist',
  },
  '23502': {
    statusCode: 400,
    errorCode: 'NOT_NULL_VIOLATION',
    message: 'Required field is missing',
  },
  PGRST116: { statusCode: 404, errorCode: 'NOT_FOUND', message: 'Resource not found' },
  '42501': {
    statusCode: 403,
    errorCode: 'INSUFFICIENT_PRIVILEGE',
    message: 'Insufficient database privileges',
  },
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
