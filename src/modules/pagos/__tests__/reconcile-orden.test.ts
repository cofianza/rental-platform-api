import { describe, it, expect, vi } from 'vitest';

// Barrido de reconciliación con Mercado Pago: toma a lo sumo 50 filas, así que
// debe tomar las más recientes. Sin orden, 50 cobros abandonados o fallidos de
// la semana podían dejar fuera el pago que acaba de entrar con plata real.

const { mockFrom, ops } = vi.hoisted(() => {
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const PASSTHROUGH = ['select', 'eq', 'in', 'gte', 'lte', 'order', 'limit'];
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of PASSTHROUGH) {
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    }
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
    return chain;
  };
  return { mockFrom: vi.fn((table: string) => chainFor(table)), ops };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t) } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/config', () => ({ env: { FRONTEND_URL: 'http://localhost:3000' } }));
vi.mock('@/lib/email', () => ({ sendPaymentLinkEmail: vi.fn() }));
vi.mock('@/lib/tenantScope', () => ({ assertExpedienteAccess: vi.fn(async () => undefined) }));
vi.mock('@/modules/estudios/tope-canon.guard', () => ({ assertCanonDentroDelTope: vi.fn() }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({
  notificarUsuario: vi.fn(async () => undefined),
  findPerfilIdByEmail: vi.fn(async () => null),
  notificarResponsableExpediente: vi.fn(async () => undefined),
}));
vi.mock('@/modules/orchestrator/orchestrator.service', () => ({ onPagoConfirmado: vi.fn() }));
vi.mock('../gateway', () => ({
  getPaymentGateway: () => ({ provider: 'mercadopago', searchPaymentsByReference: vi.fn(async () => []) }),
}));

import { reconcilePendingPagos } from '../pagos.service';

describe('reconcilePendingPagos', () => {
  it('revisa primero los cobros y compras más recientes', async () => {
    await reconcilePendingPagos();
    for (const table of ['pagos', 'compras_creditos_estudios']) {
      const orden = ops.filter((o) => o.table === table && o.method === 'order').map((o) => o.args);
      expect(orden, table).toEqual([['created_at', { ascending: false }]]);
    }
  });
});
