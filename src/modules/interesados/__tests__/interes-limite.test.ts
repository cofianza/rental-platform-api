import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';

// ============================================================
// Tope por IP del «Me interesa» (P9): la validación va antes del tope, así los
// envíos inválidos no cuentan y todos los válidos sí, también los que terminan
// en error (con skipFailedRequests se descontaban, y cortar la conexión dejaba
// salir el aviso sin gastar cupo).
// ============================================================

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/config', () => ({ env: { NODE_ENV: 'test', RATE_LIMIT_MAX: 1000 } }));
vi.mock('@/config/env', () => ({ env: { NODE_ENV: 'test' } }));
vi.mock('../interesados.service', async () => {
  const { AppError } = await import('@/lib/errors');
  return {
    registrarInteresPublico: vi.fn(async () => {
      throw AppError.notFound('Inmueble no encontrado o no disponible', 'INMUEBLE_NOT_FOUND');
    }),
  };
});

import { publicPropertiesRouter } from '@/modules/inmuebles/public-properties.routes';
import { errorHandler } from '@/middleware/errorHandler';

let base = '';
let server: ReturnType<ReturnType<typeof express>['listen']>;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/public/properties', publicPropertiesRouter);
  app.use(errorHandler);
  await new Promise<void>((ok) => {
    server = app.listen(0, '127.0.0.1', () => ok());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/public/properties`;
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

const enviar = (body: Record<string, unknown>) =>
  fetch(`${base}/3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f/interes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.status);

const VALIDO = { nombre: 'Ana Pérez', telefono: '3001112233', email: 'ana@correo.co', acepta: true };

describe('POST /public/properties/:id/interes — tope por IP', () => {
  it('los inválidos no gastan cupo; los válidos sí, aunque terminen en error', async () => {
    for (let i = 0; i < 25; i++) expect(await enviar({ ...VALIDO, nombre: 'Ana falso.info' })).toBe(400);
    for (let i = 0; i < 20; i++) expect(await enviar(VALIDO)).toBe(404);
    expect(await enviar(VALIDO)).toBe(429);
  });
});
