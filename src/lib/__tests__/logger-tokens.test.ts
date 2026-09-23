import { describe, it, expect, vi } from 'vitest';

vi.mock('@/config/env', () => ({ env: { LOG_LEVEL: 'silent', NODE_ENV: 'test' } }));

import { httpLogSerializers } from '@/lib/logger';

// pino-http registraba la URL entera: el token de los enlaces públicos quedaba en los logs.
describe('httpLogSerializers.req', () => {
  const token = 'a1'.repeat(32);
  it.each([
    [`/api/v1/public/autorizar/${token}`, '/api/v1/public/autorizar/***'],
    [`/api/v1/auth/reset-password/${token.toUpperCase()}`, '/api/v1/auth/reset-password/***'],
    // Meta antepone el placeholder «{{1}}» (url-encoded) al token de la cita.
    [`/api/v1/public/visita/%7B%7B1%7D%7D${token}/confirmar`, '/api/v1/public/visita/%7B%7B1%7D%***/confirmar'],
    ['/api/v1/expedientes/3f0c2a1e-9b7d-4c1a-8e2f-0a1b2c3d4e5f', '/api/v1/expedientes/3f0c2a1e-9b7d-4c1a-8e2f-0a1b2c3d4e5f'],
  ])('%s → %s', (url, esperado) => {
    expect(httpLogSerializers.req({ url }).url).toBe(esperado);
  });
});
