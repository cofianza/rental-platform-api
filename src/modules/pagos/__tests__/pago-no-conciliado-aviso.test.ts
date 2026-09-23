import { describe, it, expect, vi, beforeEach } from 'vitest';

// Dinero que entra a Mercado Pago sin cobro que le corresponda: además de la
// fila en pagos_no_conciliados, se avisa a los administradores una sola vez.
// Mock de Supabase con colas por tabla, como mp-webhook-cancelled.

const { mockFrom, queues, enqueue, mockStatus, mockNotificarYCorreo } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'in', 'order', 'limit', 'gte', 'lte'];
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of PASSTHROUGH) chain[m] = () => chain;
    chain.maybeSingle = async () => next(table);
    chain.single = async () => next(table);
    chain.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  return {
    mockFrom: vi.fn((table: string) => chainFor(table)),
    queues,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    mockStatus: vi.fn(),
    mockNotificarYCorreo: vi.fn(async () => undefined),
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
  notificarYCorreo: mockNotificarYCorreo,
  findPerfilIdByEmail: vi.fn(async () => null),
  notificarResponsableExpediente: vi.fn(async () => undefined),
}));
vi.mock('@/modules/orchestrator/orchestrator.service', () => ({ onPagoConfirmado: vi.fn() }));
vi.mock('../gateway', () => ({
  getPaymentGateway: () => ({
    provider: 'mercadopago',
    verifyWebhook: () => ({ event: {}, type: 'payment', eventId: 'mp-pay-9' }),
    getPaymentStatus: mockStatus,
  }),
}));

import { processWebhookEvent } from '../pagos.service';

const EXP = '11111111-1111-1111-1111-111111111111';
const PAGO = '22222222-2222-2222-2222-222222222222';

// Pago aprobado por un monto distinto al del cobro: cae en pagos_no_conciliados.
function montoDistinto() {
  mockStatus.mockResolvedValueOnce({
    status: 'completed',
    transactionRef: 'mp-pay-9',
    rawResponse: { external_reference: `garantia:${EXP}:${PAGO}`, transaction_amount: 150 },
  });
  enqueue('pagos', {
    data: { id: PAGO, estado: 'pendiente', monto: 1500000, expediente_id: EXP, transaction_ref: null },
    error: null,
  });
}

describe('pago no conciliado: aviso a los administradores', () => {
  beforeEach(() => {
    queues.clear();
    vi.clearAllMocks();
  });

  it('fila nueva: in-app + correo a cada administrador activo, con monto, motivo e ids', async () => {
    montoDistinto();
    enqueue('pagos_no_conciliados', { data: [{ id: 'pnc-1' }], error: null });
    enqueue('perfiles', { data: [{ id: 'admin-1' }, { id: 'admin-2' }], error: null });

    await processWebhookEvent(Buffer.from('{}'), {});

    await vi.waitFor(() => expect(mockNotificarYCorreo).toHaveBeenCalledTimes(2));
    expect(mockNotificarYCorreo).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'admin-1',
        tipo: 'pago.no_conciliado',
        link: `/expedientes/${EXP}`,
        mensaje: expect.stringMatching(/\$150 .*el monto no coincide.*mp-pay-9/),
        payload: expect.objectContaining({ pago_no_conciliado_id: 'pnc-1', provider_payment_id: 'mp-pay-9' }),
      }),
    );
  });

  it('reintento del webhook (la fila ya existía): no se vuelve a avisar', async () => {
    montoDistinto();
    enqueue('pagos_no_conciliados', { data: [], error: null });
    enqueue('perfiles', { data: [{ id: 'admin-1' }], error: null });

    await processWebhookEvent(Buffer.from('{}'), {});
    await new Promise((r) => setTimeout(r, 10));

    expect(mockNotificarYCorreo).not.toHaveBeenCalled();
  });
});
