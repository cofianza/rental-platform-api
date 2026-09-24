/**
 * Invitar al equipo tiene su propio límite, por usuario: cada invitación sale
 * como un correo de Cofianza a cualquier dirección.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('@/config', () => ({ env: { NODE_ENV: 'production', RATE_LIMIT_MAX: 300 } }));

import { invitarMiembroLimiter } from '@/middleware/rateLimiter';

/** Una petición de `userId` desde la misma IP; resuelve con el status (200 si pasa, 500 si falla). */
function invitar(userId: string): Promise<number> {
  return new Promise((resolve) => {
    const req = { user: { id: userId }, ip: '203.0.113.7', headers: {}, method: 'POST' } as unknown as Request;
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
    void invitarMiembroLimiter(req, res, (err?: unknown) => resolve(err ? 500 : 200));
  });
}

describe('invitarMiembroLimiter', () => {
  it('20 por hora por usuario; el 21.º recibe 429 y otro usuario de la misma red sigue', async () => {
    const estados: number[] = [];
    for (let i = 0; i < 21; i++) estados.push(await invitar('titular-a'));
    expect(estados.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(estados[20]).toBe(429);
    expect(await invitar('titular-b')).toBe(200);
  });
});

