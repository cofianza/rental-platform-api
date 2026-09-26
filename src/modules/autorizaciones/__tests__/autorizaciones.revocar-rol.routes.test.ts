/**
 * Revocar la autorizacion: solo el titular revoca, ante Cofianza (Ley 1581
 * art. 8, Decreto 1377 art. 9 y 20). La ruta es de Cofianza, que registra la
 * solicitud; el gestor (inmobiliaria o propietario) cancela el estudio.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { handler } = vi.hoisted(() => ({
  handler: vi.fn((_req: unknown, res: { end: () => void }) => res.end()),
}));

vi.mock('@/lib/supabase', () => ({ supabase: {}, supabaseAuth: {} }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/config', () => ({ env: {} }));
vi.mock('@/middleware/rateLimiter', () => {
  const pasa = (_req: unknown, _res: unknown, next: () => void) => next();
  return { publicFormLimiter: pasa, otpSendByTokenLimiter: pasa, otpVerifyByTokenLimiter: pasa };
});
vi.mock('@/middleware/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/middleware/auth')>()),
  authMiddleware: (req: { user?: unknown; headers: Record<string, string> }, _res: unknown, next: () => void) => {
    req.user = { id: 'u1', rol: req.headers['x-rol'] };
    next();
  },
}));
// Todos los handlers son el mismo espía: la prueba solo llama /revocar.
vi.mock('../autorizaciones.controller', () =>
  Object.fromEntries(
    ['getAutorizacionStatus', 'enviarEnlace', 'revocarAutorizacion', 'getAutorizacionPublic', 'getPagoProspecto', 'firmar',
      'enviarOtp', 'verificarOtp', 'guardarPerfil', 'verificarBiometria', 'omitirBiometria', 'reportarIdentidad',
      'confirmarIdentidad'].map((k) => [k, handler]),
  ),
);

import { expedienteAutorizacionRouter } from '../autorizaciones.routes';

const ID = '11111111-1111-4111-8111-111111111111';
const BODY = { canal: 'whatsapp', fecha_solicitud: '2026-09-20', motivo: 'Mensaje del titular del 20/09 pidiendo revocar' };

function revocarComo(rol: string): Promise<{ statusCode?: number } | undefined> {
  return new Promise((resolve) => {
    const req = {
      method: 'PATCH', url: '/revocar', headers: { 'x-rol': rol }, query: {}, params: { expedienteId: ID }, body: BODY,
    };
    const res = { end: () => resolve(undefined) };
    (expedienteAutorizacionRouter as unknown as (a: unknown, b: unknown, c: (e?: unknown) => void) => void)(req, res, (e) =>
      resolve(e as { statusCode?: number }),
    );
  });
}

beforeEach(() => {
  handler.mockClear();
});

describe('PATCH /expedientes/:id/autorizacion-riesgo/revocar', () => {
  it.each(['inmobiliaria', 'propietario', 'gerencia_consulta', 'solicitante'])('%s: 403', async (rol) => {
    expect(await revocarComo(rol)).toMatchObject({ statusCode: 403 });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(['administrador', 'operador_analista'])('%s registra la solicitud del titular', async (rol) => {
    expect(await revocarComo(rol)).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
