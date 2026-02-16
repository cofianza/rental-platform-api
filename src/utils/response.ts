import { Response } from 'express';
import type { PaginationMeta } from './pagination';

interface SuccessResponse<T> {
  success: true;
  data: T;
  meta?: PaginationMeta;
}

export function sendSuccess<T>(
  res: Response,
  data: T,
  meta?: PaginationMeta,
  statusCode: number = 200,
): void {
  const body: SuccessResponse<T> = { success: true, data };
  if (meta) body.meta = meta;
  res.status(statusCode).json(body);
}

export function sendError(
  res: Response,
  statusCode: number,
  errorCode: string,
  message: string,
  details?: unknown,
): void {
  const body: { success: false; errorCode: string; message: string; details?: unknown } = {
    success: false,
    errorCode,
    message,
  };
  if (details !== undefined) body.details = details;
  res.status(statusCode).json(body);
}
