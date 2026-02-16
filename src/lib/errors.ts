export class AppError extends Error {
  public readonly statusCode: number;
  public readonly errorCode: string;
  public readonly details?: unknown;

  constructor(statusCode: number, errorCode: string, message: string, details?: unknown) {
    super(message);
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
