import { Response } from 'express';

interface PaginationMeta {
  page: number;
  size: number;
  total: number;
  totalPages: number;
}

export function sendSuccess<T>(res: Response, data: T, statusCode = 200, pagination?: PaginationMeta) {
  res.status(statusCode).json({
    success: true,
    data,
    ...(pagination && { pagination }),
  });
}

export function sendCreated<T>(res: Response, data: T) {
  sendSuccess(res, data, 201);
}

export function sendNoContent(res: Response) {
  res.status(204).send();
}
