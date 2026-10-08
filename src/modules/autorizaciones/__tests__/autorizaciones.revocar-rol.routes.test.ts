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
      'confirmarIdentidad', 'corregirDocumento', 'getTraza', 'bloqueosPendientes'].map((k) => [k, handler]),
  ),
);

import { expedienteAutorizacionRouter } from '../autorizaciones.routes';
import { corregirDocumentoSchema } from '../autorizaciones.schema';

const ID = '11111111-1111-4111-8111-111111111111';
const BODY = { canal: 'whatsapp', fecha_solicitud: '2026-09-20', motivo: 'Mensaje del titular del 20/09 pidiendo revocar' };

function revocarComo(rol: string): Promise<{ statusCode?: number } | undefined> {
  return llamarComo(rol, 'PATCH', '/revocar', BODY);
}

function llamarComo(rol: string, method: string, url: string, body?: unknown): Promise<{ statusCode?: number } | undefined> {
  return new Promise((resolve) => {
    const req = {
      method, url, headers: { 'x-rol': rol }, query: {}, params: { expedienteId: ID }, body,
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

// BLQ §3 y §7: la corrección es del gestor (y de Cofianza); la traza, solo de Cofianza.
describe('PATCH /documento y GET /traza (bloqueo por documento)', () => {
  const CORR = { tipo_documento: 'cc', numero_documento: '1023456789', fuente_verificacion: 'documento_fisico' };

  it.each(['gerencia_consulta', 'solicitante'])('%s no corrige el documento: 403', async (rol) => {
    expect(await llamarComo(rol, 'PATCH', '/documento', CORR)).toMatchObject({ statusCode: 403 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('sin fuente de verificación (o con una inventada) el body no valida: 400', () => {
    const sinFuente: Partial<typeof CORR> = { ...CORR };
    delete sinFuente.fuente_verificacion;
    expect(corregirDocumentoSchema.safeParse(sinFuente).success).toBe(false);
    expect(corregirDocumentoSchema.safeParse({ ...CORR, fuente_verificacion: 'lo_digito_el_prospecto' }).success).toBe(false);
    expect(corregirDocumentoSchema.safeParse(CORR).success).toBe(true);
  });

  it.each(['inmobiliaria', 'propietario', 'administrador', 'operador_analista'])('%s corrige con fuente', async (rol) => {
    expect(await llamarComo(rol, 'PATCH', '/documento', CORR)).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it.each(['inmobiliaria', 'propietario', 'solicitante'])('%s no ve la traza: 403', async (rol) => {
    expect(await llamarComo(rol, 'GET', '/traza')).toMatchObject({ statusCode: 403 });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(['administrador', 'operador_analista', 'gerencia_consulta'])('%s ve la traza', async (rol) => {
    expect(await llamarComo(rol, 'GET', '/traza')).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
