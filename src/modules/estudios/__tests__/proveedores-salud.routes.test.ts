/**
 * GET /proveedores-riesgo/salud lanza consultas en vivo contra los burós: solo
 * Cofianza. configuracion:read también lo tienen el propietario, la
 * inmobiliaria y el prospecto.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { handler, HANDLERS } = vi.hoisted(() => ({
  handler: vi.fn((_req: unknown, res: { end: () => void }) => res.end()),
  HANDLERS: [
    'cancel', 'confirmarSoporte', 'create', 'createFromInmueble', 'descargarCertificado', 'ejecutarEstudio',
    'estudioVigentePorDocumento', 'generarCertificado', 'getById', 'getCertificadoPresignedUrl', 'getCertificadoUrl',
    'getEstadoProveedor', 'getFormulario', 'getHistorial', 'getProviderHealth', 'getSoportePresignedUrl', 'getTarifa',
    'getTopeCanon', 'listAll', 'listByExpediente', 'quitarTarifaOverride', 'reasignar', 'reEvaluar', 'registrarRadicacionApelacion', 'registrarResultado',
    'sendLink', 'setTarifaOverride', 'stats', 'submitFormulario', 'verificarCertificadoPublic',
  ],
}));

vi.mock('@/lib/supabase', () => ({ supabase: {}, supabaseAuth: {} }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/tenantScope', () => ({ resolveRolMiembro: vi.fn() }));
vi.mock('@/middleware/rateLimiter', () => ({ publicFormLimiter: (_q: unknown, _s: unknown, next: () => void) => next() }));
// La autenticación real consulta Supabase; aquí el rol llega en un header.
vi.mock('@/middleware/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/middleware/auth')>()),
  authMiddleware: (req: { user?: unknown; headers: Record<string, string> }, _res: unknown, next: () => void) => {
    req.user = { id: 'u1', rol: req.headers['x-rol'] };
    next();
  },
}));
vi.mock('../estudios.controller', () => Object.fromEntries(HANDLERS.map((h) => [h, handler])));

import { proveedoresRiesgoRouter } from '../estudios.routes';

/** Pasa GET /salud por el router: sin error = llegó al controlador. */
function saludComo(rol: string): Promise<{ statusCode?: number } | undefined> {
  return new Promise((resolve) => {
    const req = { method: 'GET', url: '/salud', headers: { 'x-rol': rol }, query: {}, params: {}, body: {} };
    const res = { end: () => resolve(undefined) };
    (proveedoresRiesgoRouter as unknown as (a: unknown, b: unknown, c: (e?: unknown) => void) => void)(req, res, (e) =>
      resolve(e as { statusCode?: number }),
    );
  });
}

beforeEach(() => {
  handler.mockClear();
});

describe('/proveedores-riesgo/salud', () => {
  it('propietario, inmobiliaria y prospecto reciben 403 aunque tengan configuracion:read', async () => {
    for (const rol of ['propietario', 'inmobiliaria', 'solicitante']) {
      expect(await saludComo(rol)).toMatchObject({ statusCode: 403 });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('administrador y operador llegan al controlador', async () => {
    expect(await saludComo('administrador')).toBeUndefined();
    expect(await saludComo('operador_analista')).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
