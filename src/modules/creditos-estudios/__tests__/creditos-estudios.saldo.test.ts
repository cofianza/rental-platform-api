import { describe, it, expect, vi, beforeEach } from 'vitest';

// P22: el contracargo de una compra retira lo no usado; lo usado queda como
// saldo en contra, que bloquea pagar con créditos y se descuenta de la próxima
// compra. Mock de Supabase con colas por tabla, como creditos-estudios.org.

const { mockFrom, mockRpc, ops, queues, enqueue } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'in', 'gt', 'or', 'order', 'limit'];
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
    mockRpc: vi.fn(),
    ops,
    queues,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t), rpc: mockRpc } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/config', () => ({ env: { FRONTEND_URL: 'http://localhost:3000' } }));
vi.mock('@/modules/pagos/gateway', () => ({ getPaymentGateway: vi.fn() }));
vi.mock('@/modules/estudios/tope-canon.guard', () => ({ assertCanonDentroDelTope: vi.fn(async () => undefined) }));
vi.mock('@/modules/orchestrator/orchestrator.service', () => ({ onEstudioPagado: vi.fn(async () => undefined) }));
vi.mock('@/modules/facturacion/facturacion.service', () => ({ crearFacturaDesdeCompraCreditos: vi.fn(async () => ({})) }));
vi.mock('@/lib/tenantScope', () => ({
  perfilEsDuenoDeInmueble: vi.fn(async () => true),
  resolveOrgCanonicalPerfilId: vi.fn(async (id: string) => id),
}));

import { revertirCompraCreditos, liberarEstudioConCredito, acreditarCompraDesdeWebhook } from '../creditos-estudios.service';

const updates = (table: string) => ops.filter((o) => o.table === table && o.method === 'update').map((o) => o.args[0]);
const inserts = (table: string) => ops.filter((o) => o.table === table && o.method === 'insert').map((o) => o.args[0]);

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
});

describe('P22: contracargo de una compra de créditos', () => {
  const compraCompletada = () =>
    enqueue(
      'compras_creditos_estudios',
      { data: { id: 'compra-1', perfil_id: 'owner-1', estado: 'completado' }, error: null },
      { data: [{ id: 'compra-1' }], error: null }, // CAS a cancelado
    );

  it('retira los no usados, deja los usados en contra y trae los consumos para la disputa', async () => {
    compraCompletada();
    enqueue(
      'lotes_creditos_estudios',
      { data: { id: 'lote-9', cantidad_inicial: 10, cantidad_disponible: 4 }, error: null },
      { data: [{ id: 'lote-9' }], error: null }, // CAS a 0
      { data: [{ cantidad_disponible: 3 }], error: null }, // saldo vigente
    );
    enqueue('movimientos_creditos_estudios', { data: null, error: null }, { data: [{ expediente_id: 'e1' }, { expediente_id: 'e2' }, { expediente_id: 'e1' }], error: null });
    enqueue('expedientes', { data: [{ numero: 'EXP-1' }, { numero: 'EXP-2' }], error: null });

    const r = await revertirCompraCreditos('compra-1');

    expect(r).toEqual({
      compra_id: 'compra-1',
      perfil_id: 'owner-1',
      retirados: 4,
      en_contra: 6,
      en_contra_registrado: true,
      consumos: ['EXP-1', 'EXP-2'],
    });
    expect(updates('compras_creditos_estudios')).toEqual([{ estado: 'cancelado' }, { creditos_en_contra: 6 }]);
    expect(updates('lotes_creditos_estudios')).toEqual([{ cantidad_disponible: 0 }]);
    expect(inserts('movimientos_creditos_estudios')[0]).toMatchObject({ tipo: 'ajuste', cantidad: -4, saldo_resultante: 3 });
  });

  it('un reintento sobre una compra ya revertida no hace nada', async () => {
    enqueue('compras_creditos_estudios', { data: { id: 'compra-1', perfil_id: 'owner-1', estado: 'cancelado' }, error: null });

    expect(await revertirCompraCreditos('compra-1')).toBeNull();
    expect(updates('compras_creditos_estudios')).toEqual([]);
    expect(updates('lotes_creditos_estudios')).toEqual([]);
  });

  it('sin la migración de la columna: retira igual y avisa que los usados no quedaron en contra', async () => {
    compraCompletada();
    enqueue(
      'lotes_creditos_estudios',
      { data: { id: 'lote-9', cantidad_inicial: 10, cantidad_disponible: 0 }, error: null },
      { data: [{ id: 'lote-9' }], error: null },
    );
    enqueue('compras_creditos_estudios', { data: null, error: { code: 'PGRST204', message: 'column not found' } });

    const r = await revertirCompraCreditos('compra-1');

    expect(r).toMatchObject({ retirados: 0, en_contra: 10, en_contra_registrado: false });
  });

  it('con saldo en contra no se paga una evaluación con créditos (las otras opciones siguen)', async () => {
    enqueue('expedientes', { data: { id: 'exp-1', numero: 'EXP-1', estado: 'en_revision', inmueble_id: 'inm-1', solicitante_id: 'sol-1' }, error: null });
    enqueue('inmuebles', { data: { propietario_id: 'owner-1', inmobiliaria_id: 'org-1', direccion: 'Calle 1', ciudad: 'Bogotá' }, error: null });
    enqueue('compras_creditos_estudios', { data: [{ creditos_en_contra: 2 }], error: null });

    await expect(liberarEstudioConCredito('exp-1', 'owner-1', 'owner-1')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'CREDITOS_EN_CONTRA',
      message: expect.stringContaining('próxima compra'),
    });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(inserts('pagos')).toEqual([]);
  });

  it('la próxima compra descuenta el saldo en contra: el lote nace descontado y la deuda queda en 0', async () => {
    enqueue(
      'compras_creditos_estudios',
      { data: { id: 'compra-2', perfil_id: 'owner-1', estado: 'pendiente', cantidad_estudios: 10, vence_en_dias: null }, error: null },
      { data: [{ creditos_en_contra: 3 }], error: null }, // saldo en contra
      { data: [{ id: 'compra-1', creditos_en_contra: 3 }], error: null }, // deudas a cubrir
      { data: [{ id: 'compra-1' }], error: null }, // CAS de la deuda
    );
    enqueue('lotes_creditos_estudios', { data: { id: 'lote-2' }, error: null }, { data: [{ cantidad_disponible: 7 }], error: null });

    await acreditarCompraDesdeWebhook('pref-2', 'mp-2', {});

    expect(inserts('lotes_creditos_estudios')[0]).toMatchObject({ cantidad_inicial: 10, cantidad_disponible: 7 });
    expect(updates('compras_creditos_estudios')).toContainEqual({ creditos_en_contra: 0 });
    const movs = inserts('movimientos_creditos_estudios');
    expect(movs[0]).toMatchObject({ tipo: 'compra', cantidad: 10, saldo_resultante: 10 });
    expect(movs[1]).toMatchObject({ tipo: 'ajuste', cantidad: -3, saldo_resultante: 7 });
  });
});
