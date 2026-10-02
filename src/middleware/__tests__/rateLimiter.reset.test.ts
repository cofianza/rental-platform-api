/**
 * «Recuperar contraseña»: 3 enlaces por hora por correo. La clave del tope usa
 * la misma normalización que el schema (recorte + minúsculas): el tope va antes
 * de validate, y si no las variantes con mayúsculas o espacios del mismo correo
 * sumarían cupos distintos hacia el mismo buzón.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('@/config', () => ({ env: { NODE_ENV: 'production', RATE_LIMIT_MAX: 300 } }));

import { passwordResetLimiter } from '@/middleware/rateLimiter';

/** Un pedido con ese cuerpo; resuelve con el status (200 si pasa, 500 si el limitador falla). */
function pedir(body: unknown, ip = '203.0.113.7'): Promise<number> {
  return new Promise((resolve) => {
    const req = { body, ip, headers: {}, method: 'POST' } as unknown as Request;
    const res = {
      statusCode: 200,
      headersSent: false,
      setHeader: () => undefined,
      getHeader: () => undefined,
      append: () => undefined,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      send() {
        resolve(this.statusCode);
      },
      json() {
        resolve(this.statusCode);
      },
    } as unknown as Response;
    void passwordResetLimiter(req, res, (err?: unknown) => resolve(err ? 500 : 200));
  });
}

describe('passwordResetLimiter', () => {
  it('mayúsculas y espacios del mismo correo comparten el cupo; otro correo de la misma red sigue', async () => {
    expect(await pedir({ email: 'Maria.Perez@Gmail.COM' })).toBe(200);
    expect(await pedir({ email: '  maria.perez@gmail.com ' })).toBe(200);
    expect(await pedir({ email: 'MARIA.PEREZ@GMAIL.COM\n' })).toBe(200);
    expect(await pedir({ email: ' maria.perez@gmail.com' })).toBe(429);
    expect(await pedir({ email: 'otra@gmail.com' })).toBe(200);
  });

  it('un cuerpo sin correo, o con uno que no es texto, no tumba el limitador', async () => {
    expect(await pedir({})).toBe(200);
    expect(await pedir({ email: 12345 })).toBe(200);
    expect(await pedir({ email: { a: 1 } })).toBe(200);
  });
});
