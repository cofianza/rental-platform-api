/**
 * H99: quién puede pagar con créditos un estudio. La inmobiliaria como antes;
 * admin/operador con el crédito de la org dueña; gerencia_consulta nunca.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/middleware/auth', () => ({
  authMiddleware: vi.fn(),
  roleGuard: (roles: string[]) => Object.assign(vi.fn(), { roles }),
}));
vi.mock('@/middleware/validate', () => ({ validate: () => vi.fn() }));
vi.mock('../creditos-estudios.controller', () =>
  Object.fromEntries(
    ['listPaquetes', 'getMiSaldo', 'getMisMovimientos', 'getMisCompras', 'comprarPaquete', 'facturarCompra', 'liberarEstudio', 'getSaldoInmobiliariaDeExpediente', 'adminListPaquetes', 'adminCreatePaquete', 'adminUpdatePaquete', 'adminDeletePaquete'].map((n) => [n, vi.fn()]),
  ),
);

import { expedienteLiberarRouter } from '../creditos-estudios.routes';

type Capa = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: { roles?: string[] } }> } };
const roles = (path: string, method: string) =>
  (expedienteLiberarRouter.stack as unknown as Capa[])
    .find((c) => c.route?.path === path && c.route.methods[method])
    ?.route?.stack.map((s) => s.handle.roles)
    .find(Boolean);

describe('rutas de liberar con crédito', () => {
  it('POST: inmobiliaria, administrador y operador (no gerencia)', () => {
    expect(roles('/', 'post')).toEqual(['inmobiliaria', 'administrador', 'operador_analista']);
  });
  it('GET /saldo de la org dueña: solo admin/operador', () => {
    expect(roles('/saldo', 'get')).toEqual(['administrador', 'operador_analista']);
  });
});
