/**
 * El catálogo de tipos de documento es global: solo el administrador lo lee y
 * lo edita. configuracion:update no basta, porque también lo tienen el
 * propietario y la inmobiliaria (para sus propios datos).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { handler } = vi.hoisted(() => ({
  handler: vi.fn((_req: unknown, res: { end: () => void }) => res.end()),
}));

vi.mock('@/lib/supabase', () => ({ supabase: {}, supabaseAuth: {} }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/tenantScope', () => ({ resolveRolMiembro: vi.fn() }));
// La autenticación real consulta Supabase; aquí el rol llega en un header.
vi.mock('@/middleware/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/middleware/auth')>()),
  authMiddleware: (req: { user?: unknown; headers: Record<string, string> }, _res: unknown, next: () => void) => {
    req.user = { id: 'u1', rol: req.headers['x-rol'] };
    next();
  },
}));
vi.mock('../admin-tipos-documento.controller', () => ({
  list: handler, getById: handler, create: handler, update: handler,
  toggleActivo: handler, reordenar: handler, checkCodigo: handler,
}));

import router from '../admin-tipos-documento.routes';

/** Pasa GET / por el router: sin error = llegó al controlador. */
function listarComo(rol: string): Promise<{ statusCode?: number } | undefined> {
  return new Promise((resolve) => {
    const req = { method: 'GET', url: '/', headers: { 'x-rol': rol }, query: {}, params: {}, body: {} };
    const res = { end: () => resolve(undefined) };
    (router as unknown as (a: unknown, b: unknown, c: (e?: unknown) => void) => void)(req, res, (e) =>
      resolve(e as { statusCode?: number }),
    );
  });
}

beforeEach(() => {
  handler.mockClear();
});

describe('/admin/tipos-documento', () => {
  it('propietario e inmobiliaria reciben 403 aunque tengan configuracion:update', async () => {
    expect(await listarComo('propietario')).toMatchObject({ statusCode: 403 });
    expect(await listarComo('inmobiliaria')).toMatchObject({ statusCode: 403 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('el administrador llega al controlador', async () => {
    expect(await listarComo('administrador')).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
