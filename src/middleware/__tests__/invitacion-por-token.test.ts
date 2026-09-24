import { describe, it, expect, vi } from 'vitest';

// P18 (revisión 2026-09-24): invitar al co-arrendatario desde el enlace del
// prospecto manda correo y WhatsApp a un tercero. Límite por enlace (no por IP)
// y esquema estricto: solo cédula de ciudadanía o de extranjería y nombres sin
// enlaces.

vi.mock('@/config', () => ({ env: { NODE_ENV: 'production', RATE_LIMIT_MAX: 300 } }));

import { invitacionPorTokenLimiter } from '../rateLimiter';
import { invitarCoarrendatarioPublicoSchema } from '@/modules/coarrendatarios/coarrendatarios.schema';

async function invitar(token: string) {
  const res = {
    headersSent: false,
    writableEnded: false,
    statusCode: 200,
    setHeader: vi.fn(),
    append: vi.fn(),
    on: vi.fn(),
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send: vi.fn(),
  };
  const next = vi.fn();
  await invitacionPorTokenLimiter({ params: { token }, ip: '1.1.1.1', headers: {} } as never, res as never, next);
  return { res, next };
}

describe('invitacionPorTokenLimiter', () => {
  it('3 invitaciones por enlace al día; la 4.ª es 429 y otro enlace sigue libre', async () => {
    const enlace = 'a'.repeat(64);
    for (let i = 0; i < 3; i++) expect((await invitar(enlace)).next).toHaveBeenCalled();

    const cuarta = await invitar(enlace);
    expect(cuarta.next).not.toHaveBeenCalled();
    expect(cuarta.res.statusCode).toBe(429);
    expect(cuarta.res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'RATE_LIMIT_EXCEEDED' }));

    expect((await invitar('b'.repeat(64))).next).toHaveBeenCalled();
  });
});

describe('invitarCoarrendatarioPublicoSchema', () => {
  const base = { nombre: 'María José', apellido: "D'Alessandro", tipo_documento: 'cc', numero_documento: '1017654321', email: 'mj@correo.co' };

  it('acepta nombres reales (tildes, apóstrofo, guion)', () => {
    expect(invitarCoarrendatarioPublicoSchema.safeParse(base).success).toBe(true);
    expect(invitarCoarrendatarioPublicoSchema.safeParse({ ...base, nombre: 'Jean-Luc', tipo_documento: 'ce' }).success).toBe(true);
  });

  it.each([
    ['un enlace en el nombre', { nombre: 'Verifica https://evil.co' }],
    ['HTML en el apellido', { apellido: '<a href="x">y</a>' }],
    ['NIT', { tipo_documento: 'nit' }],
    ['pasaporte', { tipo_documento: 'pasaporte' }],
  ])('rechaza %s', (_, cambio) => {
    expect(invitarCoarrendatarioPublicoSchema.safeParse({ ...base, ...cambio }).success).toBe(false);
  });
});
