/**
 * «Aceptar horario reprogramado» es del inquilino: con el permiso 'read' de
 * citas Gerencia o el gestor lo podían marcar en su nombre.
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
vi.mock('../citas.controller', () => ({
  listByExpediente: handler, getById: handler, create: handler, confirmar: handler, reprogramar: handler,
  acusarReprogramacion: handler, realizar: handler, cancelar: handler, noAsistio: handler,
}));

import router from '../citas.routes';

const ID = '11111111-1111-4111-8111-111111111111';
function acusarComo(rol: string): Promise<{ statusCode?: number } | undefined> {
  return new Promise((resolve) => {
    const req = { method: 'POST', url: `/${ID}/acusar-reprogramacion`, headers: { 'x-rol': rol }, query: {}, params: {}, body: {} };
    const res = { end: () => resolve(undefined) };
    (router as unknown as (a: unknown, b: unknown, c: (e?: unknown) => void) => void)(req, res, (e) =>
      resolve(e as { statusCode?: number }),
    );
  });
}

beforeEach(() => {
  handler.mockClear();
});

describe('POST /citas/:id/acusar-reprogramacion', () => {
  it.each(['gerencia_consulta', 'propietario', 'inmobiliaria', 'administrador', 'operador_analista'])('%s: 403', async (rol) => {
    expect(await acusarComo(rol)).toMatchObject({ statusCode: 403 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('el solicitante llega al controlador', async () => {
    expect(await acusarComo('solicitante')).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
