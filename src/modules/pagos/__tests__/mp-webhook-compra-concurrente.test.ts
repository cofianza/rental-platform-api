import { it, expect, vi, beforeEach } from 'vitest';

// P22 (Q5b-3): dos payments aprobados de la MISMA compra de créditos procesados
// a la vez (dos pestañas; webhook y conciliación). El segundo leía la compra aún
// 'pendiente', chocaba con el lote (23505) y salía como «ya acreditado»: su
// plata no quedaba para devolver y la compra podía quedar con SU payment. Ahora
// la compra se reclama para un payment antes de crear el lote: el segundo va a
// la cola como pago duplicado. Reproducción del revisor, con lo esperado.

const { mockFrom, ops, queues, enqueue, mockStatus } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'in', 'is', 'order', 'limit', 'gte', 'lte', 'gt', 'or', 'not'];
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
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t) } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/config', () => ({ env: { FRONTEND_URL: 'http://localhost:3000' } }));
vi.mock('@/lib/email', () => ({ sendPaymentLinkEmail: vi.fn() }));
vi.mock('@/lib/tenantScope', () => ({
  assertExpedienteAccess: vi.fn(async () => undefined),
  resolveOrgCanonicalPerfilId: vi.fn(async (id: string) => id),
  perfilEsDuenoDeInmueble: vi.fn(async () => true),
}));
vi.mock('@/modules/estudios/tope-canon.guard', () => ({ assertCanonDentroDelTope: vi.fn() }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({
  notificarUsuario: vi.fn(async () => undefined),
  notificarYCorreo: vi.fn(async () => undefined),
  findPerfilIdByEmail: vi.fn(async () => null),
  notificarResponsableExpediente: vi.fn(async () => undefined),
}));
vi.mock('@/modules/orchestrator/orchestrator.service', () => ({ onPagoConfirmado: vi.fn() }));
vi.mock('@/modules/pagos/gateway', () => ({
  getPaymentGateway: () => ({
    provider: 'mercadopago',
    verifyWebhook: () => ({ event: {}, type: 'payment', eventId: 'mp-B' }),
    getPaymentStatus: mockStatus,
  }),
}));

import { processWebhookEvent } from '@/modules/pagos/pagos.service';

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
});

it('el segundo payment aprobado que llega a la vez queda en la cola como duplicado y no toca la compra', async () => {
  mockStatus.mockResolvedValueOnce({
    status: 'completed',
    transactionRef: 'mp-B',
    rawResponse: { external_reference: 'creditos_estudios:compra-1', status: 'approved', status_detail: 'accredited', transaction_amount: 350000 },
  });
  enqueue(
    'compras_creditos_estudios',
    // webhookCompraCreditos lee la compra: todavía 'pendiente' (A no la ha completado).
    { data: { id: 'compra-1', estado: 'pendiente', stripe_session_id: 'pref-1', stripe_payment_intent_id: null }, error: null },
    // acreditarCompraDesdeWebhook: la compra por sesión
    { data: { id: 'compra-1', perfil_id: 'org-1', estado: 'pendiente', cantidad_estudios: 10, vence_en_dias: null }, error: null },
    // el reclamo no pasa: el payment A ya la tomó
    { data: [], error: null },
    { data: { stripe_payment_intent_id: 'mp-A' }, error: null },
  );
  enqueue('pagos_no_conciliados', { data: [{ id: 'fila-1' }], error: null });

  await processWebhookEvent(Buffer.from('{}'), {});

  const cola = ops.filter((o) => o.table === 'pagos_no_conciliados' && o.method === 'upsert').map((o) => o.args[0]);
  expect(cola).toEqual([expect.objectContaining({ provider_payment_id: 'mp-B', motivo: 'pago_duplicado' })]);
  expect(ops.some((o) => o.table === 'lotes_creditos_estudios' && o.method === 'insert')).toBe(false);
  const marcas = ops.filter((o) => o.table === 'compras_creditos_estudios' && o.method === 'update').map((o) => o.args[0]);
  expect(marcas).toEqual([{ stripe_payment_intent_id: 'mp-B' }]); // solo el intento de reclamo; la compra no se completa con B
});
