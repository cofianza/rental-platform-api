import { describe, it, expect, vi, beforeEach } from 'vitest';

// Los créditos de estudios son de la ORGANIZACIÓN (perfil canónico del
// titular), no de quien los compró. Mock de Supabase con colas por tabla.

const { mockFrom, mockRpc, ops, queues, enqueue, mockEsDueno, mockFactura } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'in', 'is', 'gt', 'or', 'order', 'limit'];
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
    mockRpc: vi.fn(async () => ({ data: [{ lote_id: 'lote-1', saldo_restante: 21 }], error: null })),
    ops,
    queues,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    mockEsDueno: vi.fn(async () => true),
    mockFactura: vi.fn(async () => ({ id: 'f-1' })),
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t), rpc: mockRpc } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/config', () => ({ env: { FRONTEND_URL: 'http://localhost:3000' } }));
vi.mock('@/modules/pagos/gateway', () => ({ getPaymentGateway: vi.fn() }));
vi.mock('@/modules/estudios/tope-canon.guard', () => ({ assertCanonDentroDelTope: vi.fn(async () => undefined) }));
vi.mock('@/modules/orchestrator/orchestrator.service', () => ({ onEstudioPagado: vi.fn(async () => undefined) }));
vi.mock('@/modules/facturacion/facturacion.service', () => ({ crearFacturaDesdeCompraCreditos: mockFactura }));
vi.mock('@/lib/tenantScope', () => ({
  perfilEsDuenoDeInmueble: mockEsDueno,
  // El miembro pertenece a la org cuyo titular principal es owner-1.
  resolveOrgCanonicalPerfilId: vi.fn(async (id: string) => (id === 'miembro-1' ? 'owner-1' : id)),
}));

import { getSaldoCreditos, liberarEstudioConCredito, acreditarCompraDesdeWebhook } from '../creditos-estudios.service';

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
});

describe('créditos de la organización', () => {
  it('un miembro ve el saldo del paquete que compró el titular', async () => {
    enqueue('lotes_creditos_estudios', {
      data: [{ id: 'lote-1', cantidad_disponible: 22, cantidad_inicial: 25, vence_en: null, origen: 'compra', created_at: '2026-09-01' }],
      error: null,
    });

    const saldo = await getSaldoCreditos('miembro-1');

    expect(saldo.saldo_total).toBe(22);
    expect(ops.find((o) => o.table === 'lotes_creditos_estudios' && o.method === 'eq')?.args).toEqual(['perfil_id', 'owner-1']);
  });

  it('al liberar, el crédito sale del saldo de la organización y queda quién lo liberó', async () => {
    enqueue('expedientes', { data: { id: 'exp-1', numero: 'EXP-1', inmueble_id: 'inm-1', solicitante_id: 'sol-1' }, error: null });
    enqueue('inmuebles', { data: { propietario_id: 'owner-1', inmobiliaria_id: 'org-1', direccion: 'Calle 1', ciudad: 'Bogotá' }, error: null });
    enqueue('pagos', { data: [], error: null }); // sin pago de estudio previo
    enqueue('configuracion_sistema', { data: { valor: '80000' }, error: null });
    enqueue('pagos', { data: { id: 'pago-1' }, error: null }); // insert

    const r = await liberarEstudioConCredito('exp-1', 'miembro-1', 'miembro-1');

    expect(r).toEqual({ pago_id: 'pago-1', saldo_restante: 21, lote_id: 'lote-1' });
    expect(mockEsDueno).toHaveBeenCalledWith(expect.objectContaining({ userId: 'miembro-1' }));
    expect(mockRpc).toHaveBeenCalledWith(
      'consume_credito_estudio',
      expect.objectContaining({ p_perfil_id: 'owner-1', p_usuario_id: 'miembro-1', p_pago_id: 'pago-1' }),
    );
  });

  it('al acreditar una compra pagada se dispara su factura electrónica', async () => {
    enqueue(
      'compras_creditos_estudios',
      { data: { id: 'compra-1', perfil_id: 'owner-1', estado: 'pendiente', cantidad_estudios: 25, vence_en_dias: null }, error: null },
      { data: [{ id: 'compra-1' }], error: null }, // se reclama para el payment
    );
    enqueue('lotes_creditos_estudios', { data: { id: 'lote-1' }, error: null }); // insert
    enqueue('lotes_creditos_estudios', { data: [{ cantidad_disponible: 25 }], error: null }); // saldo

    const r = await acreditarCompraDesdeWebhook('pref-1', 'mp-1', {});

    expect(r).toEqual({ ok: true, lote_id: 'lote-1' });
    await vi.waitFor(() => expect(mockFactura).toHaveBeenCalledWith('compra-1', null, undefined, null));
  });

  it('un reintento del webhook sobre una compra ya acreditada no vuelve a facturar', async () => {
    enqueue('compras_creditos_estudios', {
      data: { id: 'compra-1', perfil_id: 'owner-1', estado: 'completado', stripe_payment_intent_id: 'mp-1' },
      error: null,
    });

    expect(await acreditarCompraDesdeWebhook('pref-1', 'mp-1', {})).toEqual({ ok: true, ya_acreditado: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockFactura).not.toHaveBeenCalled();
  });
});
