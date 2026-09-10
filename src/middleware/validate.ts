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

/**
 * El `message` del 400 es lo que el web muestra en el toast. Antes era siempre
 * "Datos de entrada invalidos" y el usuario no sabia que campo corregir; ahora
 * es el mensaje del primer campo, que los schemas escriben en espanol.
 *
 * ponytail: los mensajes por defecto de zod llegan en ingles ("Invalid input",
 * "Too small: ..."), asi que se detectan por prefijo y se cambian por uno
 * generico. Si algun dia hay schemas con mensajes propios en ingles, esto los
 * trataria como genericos; la salida es darles mensaje en espanol.
 */
const MENSAJE_POR_DEFECTO_DE_ZOD = /^(Invalid|Too (small|big)|Expected|Required|Unrecognized)/;

export function mensajeDeValidacion(errors: ValidationError[]): string {
  const [primero] = errors;
  const base = MENSAJE_POR_DEFECTO_DE_ZOD.test(primero.message)
    ? 'Revisa los datos: hay un campo con un valor no válido.'
    : primero.message;
  const resto = errors.length - 1;
  return resto > 0 ? `${base} (y ${resto} ${resto === 1 ? 'error' : 'errores'} más)` : base;
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
      } else {
        // En Express 5, req.query es de solo lectura
        // Guardamos los datos parseados (con defaults aplicados) en req.validatedQuery
        (req as Request & { validatedQuery: unknown }).validatedQuery = result.data;
      }
    }

    if (errors.length > 0) {
      throw AppError.badRequest(mensajeDeValidacion(errors), 'VALIDATION_ERROR', errors);
    }

    next();
  };
}
