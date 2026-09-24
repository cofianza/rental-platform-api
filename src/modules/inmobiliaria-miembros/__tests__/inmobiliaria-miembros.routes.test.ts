/**
 * Invitar y reenviar la invitación al equipo pasan por su propio límite
 * (invitarMiembroLimiter, probado en rateLimiter.invitar.test.ts).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/config', () => ({ env: { NODE_ENV: 'production', RATE_LIMIT_MAX: 300 } }));
vi.mock('@/middleware/auth', () => ({ authMiddleware: vi.fn(), roleGuard: () => vi.fn() }));
vi.mock('@/lib/tenantScope', () => ({ invalidateMembresiasCache: vi.fn() }));
vi.mock('../inmobiliaria-miembros.controller', () =>
  Object.fromEntries(
    [
      'adminActualizarOrg', 'adminCambiarRol', 'adminListMiembros', 'adminListOrgs', 'adminRevocar', 'aceptar',
      'cambiarRol', 'getPublic', 'invitar', 'list', 'reenviar', 'registrar', 'revocar', 'salir', 'setVenTodo',
    ].map((n) => [n, vi.fn()]),
  ),
);

import { invitarMiembroLimiter } from '@/middleware/rateLimiter';
import { miembrosRouter } from '../inmobiliaria-miembros.routes';

type Capa = { route?: { path: string; stack: Array<{ handle: unknown }> } };
const manejadores = (path: string) =>
  (miembrosRouter.stack as unknown as Capa[]).find((c) => c.route?.path === path)?.route?.stack.map((s) => s.handle);

describe('rutas del equipo', () => {
  it('invitar y reenviar la invitación pasan por el límite', () => {
    expect(manejadores('/invitar')).toContain(invitarMiembroLimiter);
    expect(manejadores('/:id/reenviar')).toContain(invitarMiembroLimiter);
  });
});
