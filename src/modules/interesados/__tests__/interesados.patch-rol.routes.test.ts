/**
 * Cambiar el estado de un lead: Gerencia (solo lectura) lo hacía por API sobre
 * cualquier organización (resolveAllowedInmuebleIds le da todo), y el
 * solicitante no gestiona leads.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { handler } = vi.hoisted(() => ({
  handler: vi.fn((_req: unknown, res: { end: () => void }) => res.end()),
}));

vi.mock('@/lib/supabase', () => ({ supabase: {}, supabaseAuth: {} }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/tenantScope', () => ({ resolveRolMiembro: vi.fn() }));
vi.mock('@/middleware/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/middleware/auth')>()),
  authMiddleware: (req: { user?: unknown; headers: Record<string, string> }, _res: unknown, next: () => void) => {
    req.user = { id: 'u1', rol: req.headers['x-rol'] };
    next();
  },
}));
vi.mock('../interesados.controller', () => ({ countNuevos: handler, list: handler, updateEstado: handler }));

import { interesadosRouter } from '../interesados.routes';

const ID = '11111111-1111-4111-8111-111111111111';
function patchComo(rol: string): Promise<{ statusCode?: number } | undefined> {
  return new Promise((resolve) => {
    const req = { method: 'PATCH', url: `/${ID}`, headers: { 'x-rol': rol }, query: {}, params: {}, body: { estado: 'contactado' } };
    const res = { end: () => resolve(undefined) };
    (interesadosRouter as unknown as (a: unknown, b: unknown, c: (e?: unknown) => void) => void)(req, res, (e) =>
      resolve(e as { statusCode?: number }),
    );
  });
}

beforeEach(() => {
  handler.mockClear();
});

describe('PATCH /interesados/:id', () => {
  it.each(['gerencia_consulta', 'solicitante'])('%s: 403', async (rol) => {
    expect(await patchComo(rol)).toMatchObject({ statusCode: 403 });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(['administrador', 'operador_analista', 'propietario', 'inmobiliaria'])('%s llega al controlador', async (rol) => {
    expect(await patchComo(rol)).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
