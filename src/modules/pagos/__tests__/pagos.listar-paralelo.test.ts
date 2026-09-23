import { describe, it, expect, vi, beforeEach } from 'vitest';

// Pagos del detalle del estudio: el guard de tenant y la lectura van en
// paralelo (antes en serie), pero con 404 no sale nada. Mock de Supabase con
// colas por tabla, como pago-manual-cobro-vivo.

const { mockFrom, ops, queues, enqueue, mockGuard } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const PASSTHROUGH = ['select', 'eq', 'in', 'order', 'range'];
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of PASSTHROUGH) {
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    }
    chain.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  return {
    mockFrom: vi.fn((table: string) => chainFor(table)),
    ops,
    queues,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    mockGuard: vi.fn(async () => undefined),
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t) } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/config', () => ({ env: { FRONTEND_URL: 'http://localhost:3000' } }));
vi.mock('@/lib/email', () => ({ sendPaymentLinkEmail: vi.fn() }));
vi.mock('@/lib/tenantScope', () => ({ assertExpedienteAccess: (...a: unknown[]) => mockGuard(...(a as [])) }));
vi.mock('@/modules/estudios/tope-canon.guard', () => ({ assertCanonDentroDelTope: vi.fn() }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({
  notificarUsuario: vi.fn(async () => undefined),
  notificarYCorreo: vi.fn(async () => undefined),
  findPerfilIdByEmail: vi.fn(async () => null),
  notificarResponsableExpediente: vi.fn(async () => undefined),
}));
vi.mock('../gateway', () => ({ getPaymentGateway: () => ({ provider: 'mercadopago' }) }));

import { listPagosByExpediente } from '../pagos.service';

const EXP = '11111111-1111-1111-1111-111111111111';

describe('listPagosByExpediente', () => {
  beforeEach(() => {
    queues.clear();
    ops.length = 0;
    vi.clearAllMocks();
  });

  it('lee los pagos sin esperar al guard', async () => {
    let soltarGuard!: () => void;
    mockGuard.mockReturnValueOnce(new Promise<undefined>((r) => (soltarGuard = () => r(undefined))));
    enqueue('pagos', { data: [{ id: 'p1', estado: 'completado' }], count: 1, error: null });

    const pendiente = listPagosByExpediente(EXP, {} as never, 'u1', 'inmobiliaria');
    // Con el guard aún pendiente, la consulta de pagos ya salió.
    expect(ops.some((o) => o.table === 'pagos' && o.method === 'select')).toBe(true);
    soltarGuard();

    await expect(pendiente).resolves.toMatchObject({ pagos: [{ id: 'p1', factura: null }], pagination: { total: 1 } });
  });

  it('si el guard da 404, no devuelve nada ni busca facturas', async () => {
    mockGuard.mockRejectedValueOnce(Object.assign(new Error('Estudio no encontrado'), { statusCode: 404 }));
    enqueue('pagos', { data: [{ id: 'p1', estado: 'completado' }], count: 1, error: null });

    await expect(listPagosByExpediente(EXP, {} as never, 'intruso', 'inmobiliaria')).rejects.toMatchObject({ statusCode: 404 });
    expect(ops.some((o) => o.table === 'facturas')).toBe(false);
  });
});
