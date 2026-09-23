import { describe, it, expect, vi, beforeEach } from 'vitest';

// Webhook de Mercado Pago: un intento 'cancelled' (PSE o efectivo vencido) no
// cierra el cobro. Mock de Supabase con colas por tabla, como pago-estudio.

const { mockFrom, ops, queues, enqueue, mockStatus, mockTransition, mockOnPagoConfirmado } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'in', 'order', 'limit', 'gte', 'lte'];
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
    mockStatus: vi.fn(),
    mockTransition: vi.fn(async () => ({ pago: null, transitioned: true })),
    mockOnPagoConfirmado: vi.fn(async () => undefined),
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
  findPerfilIdByEmail: vi.fn(async () => null),
  notificarResponsableExpediente: vi.fn(async () => undefined),
}));
vi.mock('@/modules/orchestrator/orchestrator.service', () => ({ onPagoConfirmado: mockOnPagoConfirmado }));
vi.mock('../gateway', () => ({
  getPaymentGateway: () => ({
    provider: 'mercadopago',
    verifyWebhook: () => ({ event: {}, type: 'payment', eventId: 'mp-pay-1' }),
    getPaymentStatus: mockStatus,
  }),
}));
// isValidTransition real: la prueba es justamente que 'fallido' sí pueda completarse.
vi.mock('../pago-state-machine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pago-state-machine')>()),
  transitionPagoStateChecked: mockTransition,
}));

import { processWebhookEvent } from '../pagos.service';

const EXP = '11111111-1111-1111-1111-111111111111';
const PAGO = '22222222-2222-2222-2222-222222222222';
const mpStatus = (status: string) => ({
  status,
  transactionRef: 'mp-pay-1',
  rawResponse: { external_reference: `estudio:${EXP}:${PAGO}`, transaction_amount: 80000 },
});
const pagoEn = (estado: string) => ({
  data: { id: PAGO, estado, monto: 80000, expediente_id: EXP, transaction_ref: 'mp-pay-0' },
  error: null,
});

describe('webhook de Mercado Pago: intento cancelado', () => {
  beforeEach(() => {
    queues.clear();
    ops.length = 0;
    vi.clearAllMocks();
  });

  it("'cancelled' sobre un pago en proceso lo deja 'fallido' (no 'cancelado', que es final)", async () => {
    mockStatus.mockResolvedValueOnce(mpStatus('cancelled'));
    enqueue('pagos', pagoEn('procesando'));

    await processWebhookEvent(Buffer.from('{}'), {});

    expect(mockTransition).toHaveBeenCalledWith(
      expect.objectContaining({ pagoId: PAGO, targetEstado: 'fallido' }),
    );
  });

  it('si después paga con tarjeta en el mismo enlace, el pago se completa y el estudio sigue', async () => {
    mockStatus.mockResolvedValueOnce(mpStatus('completed'));
    enqueue('pagos', pagoEn('fallido'));
    enqueue('pagos', { data: { id: PAGO, expediente_id: EXP, concepto: 'estudio' }, error: null }); // dispatch

    await processWebhookEvent(Buffer.from('{}'), {});

    expect(mockTransition).toHaveBeenCalledWith(
      expect.objectContaining({ pagoId: PAGO, targetEstado: 'completado' }),
    );
    expect(mockOnPagoConfirmado).toHaveBeenCalledWith(expect.objectContaining({ pagoId: PAGO }));
    expect(ops.some((o) => o.table === 'pagos_no_conciliados')).toBe(false);
  });
});
