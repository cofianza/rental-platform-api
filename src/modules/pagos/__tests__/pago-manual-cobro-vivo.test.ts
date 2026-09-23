import { describe, it, expect, vi, beforeEach } from 'vitest';

// Pago manual con un enlace de pasarela vivo del mismo concepto: se frena para
// no cobrar dos veces. Mock de Supabase con colas por tabla, como el webhook.

const { mockFrom, ops, queues, enqueue } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'in', 'not', 'order', 'limit'];
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of PASSTHROUGH) {
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    }
    chain.maybeSingle = async () => next(table);
    chain.single = async () => next(table);
    chain.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  return {
    mockFrom: vi.fn((table: string) => chainFor(table)),
    ops,
    queues,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
  };
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
  notificarYCorreo: vi.fn(async () => undefined),
  findPerfilIdByEmail: vi.fn(async () => null),
  notificarResponsableExpediente: vi.fn(async () => undefined),
}));
vi.mock('../gateway', () => ({ getPaymentGateway: () => ({ provider: 'mercadopago' }) }));

import { registerManualPayment } from '../pagos.service';

const EXP = '11111111-1111-1111-1111-111111111111';
const input = {
  concepto: 'garantia',
  monto: 1500000,
  metodo: 'transferencia',
  fecha_pago: '2026-09-01',
} as Parameters<typeof registerManualPayment>[1];

const insertoPago = () => ops.some((o) => o.table === 'pagos' && o.method === 'insert');

describe('registerManualPayment con un cobro por pasarela vivo', () => {
  beforeEach(() => {
    queues.clear();
    ops.length = 0;
    vi.clearAllMocks();
    enqueue('expedientes', { data: { id: EXP }, error: null });
  });

  it('enlace pendiente o fallido del mismo concepto: 409 PAGO_DUPLICADO y no se registra', async () => {
    enqueue('pagos', { data: [{ id: 'p1', estado: 'fallido' }], error: null });

    await expect(registerManualPayment(EXP, input, 'op-1', 'operador_analista')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'PAGO_DUPLICADO',
    });
    expect(insertoPago()).toBe(false);
  });

  it('PSE en proceso: 409 PAGO_EN_PROCESO (no se invita a cancelarlo)', async () => {
    enqueue('pagos', { data: [{ id: 'p1', estado: 'pendiente' }, { id: 'p2', estado: 'procesando' }], error: null });

    await expect(registerManualPayment(EXP, input, 'op-1', 'operador_analista')).rejects.toMatchObject({
      errorCode: 'PAGO_EN_PROCESO',
    });
    expect(insertoPago()).toBe(false);
  });

  it('sin cobro vivo: registra el pago completado', async () => {
    enqueue('pagos', { data: [], error: null }, { data: { id: 'nuevo', estado: 'completado' }, error: null });

    const pago = await registerManualPayment(EXP, input, 'op-1', 'operador_analista');

    expect(pago).toMatchObject({ id: 'nuevo' });
    expect(insertoPago()).toBe(true);
    const filtro = ops.find((o) => o.table === 'pagos' && o.method === 'in');
    expect(filtro?.args).toEqual(['estado', ['pendiente', 'procesando', 'fallido']]);
  });
});
