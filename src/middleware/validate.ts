import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '@/lib/errors';

interface ValidationSchemas {
  body?: z.ZodType;
  params?: z.ZodType;
  query?: z.ZodType;
}

interface ValidationError {
  field: string;
  message: string;
  received?: unknown;
}

function getValueAtPath(obj: unknown, path: (string | number)[]): unknown {
  let current = obj;
  for (const key of path) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

export function validate(schemas: ValidationSchemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const errors: ValidationError[] = [];

    if (schemas.body) {
      const result = schemas.body.safeParse(req.body);
      if (!result.success) {
        for (const issue of result.error.issues) {
          errors.push({
            field: issue.path.length > 0 ? issue.path.join('.') : 'body',
            message: issue.message,
            received: getValueAtPath(req.body, issue.path as (string | number)[]),
          });
        }
      } else {
        req.body = result.data;
      }
    }

    if (schemas.params) {
      const result = schemas.params.safeParse(req.params);
      if (!result.success) {
        for (const issue of result.error.issues) {
          errors.push({
            field: issue.path.length > 0 ? issue.path.join('.') : 'params',
            message: issue.message,
            received: getValueAtPath(req.params, issue.path as (string | number)[]),
          });
        }
      }
      // En Express 5, req.params puede ser de solo lectura - la validación ya verificó los datos
    }

    if (schemas.query) {
      const result = schemas.query.safeParse(req.query);
      if (!result.success) {
        for (const issue of result.error.issues) {
          errors.push({
            field: issue.path.length > 0 ? issue.path.join('.') : 'query',
            message: issue.message,
            received: getValueAtPath(req.query, issue.path as (string | number)[]),
          });
        }
      }
      // En Express 5, req.query es de solo lectura - la validación ya verificó los datos
      // Los controladores deben usar req.query directamente (ya está validado)
    }

    if (errors.length > 0) {
      throw AppError.badRequest('Datos de entrada invalidos', 'VALIDATION_ERROR', errors);
    }

    next();
  };
}
