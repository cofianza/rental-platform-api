import { describe, it, expect, vi } from 'vitest';

// Barrido de reconciliación con Mercado Pago: toma a lo sumo 50 filas, así que
// debe tomar las más recientes. Sin orden, 50 cobros abandonados o fallidos de
// la semana podían dejar fuera el pago que acaba de entrar con plata real.

const { mockFrom, ops } = vi.hoisted(() => {
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const PASSTHROUGH = ['select', 'eq', 'in', 'gte', 'lte', 'lt', 'order', 'limit'];
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
    ops.length = 0;
    await reconcilePendingPagos();
    const orden = (table: string) => ops.filter((o) => o.table === table && o.method === 'order').map((o) => o.args);
    // pagos: la ventana de 7 días y, aparte, los 'procesando' viejos.
    expect(orden('pagos')).toEqual([['created_at', { ascending: false }], ['created_at', { ascending: false }]]);
    expect(orden('compras_creditos_estudios')).toEqual([['created_at', { ascending: false }]]);
  });

  it("sigue los 'procesando' hasta 30 días, fuera de la ventana de 7", async () => {
    ops.length = 0;
    const antes = Date.now();
    await reconcilePendingPagos();
    const pagos = ops.filter((o) => o.table === 'pagos');
    const dias = (iso: unknown) => Math.round((antes - Date.parse(String(iso))) / 86_400_000);

    expect(pagos.filter((o) => o.method === 'eq' && o.args[0] === 'estado').map((o) => o.args[1])).toEqual(['procesando']);
    expect(pagos.filter((o) => o.method === 'gte').map((o) => dias(o.args[1]))).toEqual([7, 30]);
    expect(pagos.filter((o) => o.method === 'lt').map((o) => dias(o.args[1]))).toEqual([7]);
  });
});
