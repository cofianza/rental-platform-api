/**
 * `req.ip` debe ser la IP del CLIENTE, no la del borde de Railway: de ella
 * dependen los límites por IP (registro, ingreso, «Me interesa») y la IP que se
 * guarda como evidencia de las autorizaciones y de la bitácora.
 * Railway entrega `X-Forwarded-For: <cliente>, <borde>` (logs del 2026-10-02).
 */
import { describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

vi.mock('@/config', () => ({ env: { NODE_ENV: 'production', RATE_LIMIT_MAX: 300 } }));

import { TRUST_PROXY_HOPS } from '@/middleware/rateLimiter';

/** Lo que vería la API como `req.ip` con ese X-Forwarded-For. */
function ipVista(xForwardedFor: string): Promise<string> {
  const app = express();
  app.set('trust proxy', TRUST_PROXY_HOPS);
  app.get('/', (req, res) => {
    res.send(req.ip);
  });
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      http
        .get({ host: '127.0.0.1', port, path: '/', headers: { 'x-forwarded-for': xForwardedFor } }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => server.close(() => resolve(body)));
        })
        .on('error', reject);
    });
  });
}

describe('trust proxy en Railway', () => {
  it('con «cliente, borde» req.ip es el cliente', async () => {
    expect(await ipVista('189.237.25.152, 84.17.44.228')).toBe('189.237.25.152');
  });

  it('dos visitantes detrás del mismo borde no comparten IP (ni cupo)', async () => {
    const a = await ipVista('189.237.25.152, 84.17.44.228');
    const b = await ipVista('181.50.10.20, 84.17.44.228');
    expect(a).not.toBe(b);
  });

  it('un X-Forwarded-For falso delante no suplanta la IP', async () => {
    expect(await ipVista('1.2.3.4, 189.237.25.152, 84.17.44.228')).toBe('189.237.25.152');
  });

  it('sin borde (solo el cliente) sigue siendo el cliente', async () => {
    expect(await ipVista('189.237.25.152')).toBe('189.237.25.152');
  });

  // Los casos de arriba arman su propio Express con la constante: si app.ts
  // volviera a `app.set('trust proxy', 1)`, ninguno fallaba.
  it('app.ts configura el proxy con esa constante, y una sola vez', () => {
    const appTs = readFileSync(path.resolve(__dirname, '../../app.ts'), 'utf8');
    expect(appTs).toContain("app.set('trust proxy', TRUST_PROXY_HOPS);");
    expect(appTs.match(/['"]trust proxy['"]/g)).toHaveLength(1);
  });
});
