import { describe, it, expect, vi, beforeEach } from 'vitest';

// Adenda de precios v1.0: orden de consumo (§3.4/§9.7), vigencia al acreditar
// (§3.1/§9.6), catálogo solo para la Gerencia General (§9.14) y detalle por
// paquete (§3.8). Mock de Supabase con colas por tabla, como creditos-estudios.saldo.

const { mockFrom, ops, queues, enqueue, mockCalibracion, mockAudit } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'in', 'is', 'gt', 'or', 'order', 'limit', 'range'];
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
    mockCalibracion: vi.fn(async () => ({ VIGENCIA_PAQUETE_MESES: 6 })),
    mockAudit: vi.fn(),
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t), rpc: vi.fn() } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: mockAudit, AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/config', () => ({ env: { FRONTEND_URL: 'http://localhost:3000', GERENCIA_GENERAL_EMAILS: ['gerencia@cofianza.co'] } }));
vi.mock('@/lib/calibracion', () => ({ getCalibracion: mockCalibracion }));
vi.mock('@/modules/pagos/gateway', () => ({ getPaymentGateway: vi.fn() }));
vi.mock('@/modules/estudios/tope-canon.guard', () => ({ assertCanonDentroDelTope: vi.fn(async () => undefined) }));
vi.mock('@/modules/orchestrator/orchestrator.service', () => ({ onEstudioPagado: vi.fn(async () => undefined) }));
vi.mock('@/modules/facturacion/facturacion.service', () => ({ crearFacturaDesdeCompraCreditos: vi.fn(async () => ({})) }));
vi.mock('@/lib/tenantScope', () => ({
  perfilEsDuenoDeInmueble: vi.fn(async () => true),
  resolveOrgCanonicalPerfilId: vi.fn(async (id: string) => (id === 'miembro-1' ? 'owner-1' : id)),
}));

import {
  compararOrdenConsumo,
  sumarMesesCalendario,
  acreditarCompraDesdeWebhook,
  createPaquete,
  updatePaquete,
  deletePaquete,
  listDetallePaquetes,
} from '../creditos-estudios.service';

const inserts = (table: string) => ops.filter((o) => o.table === table && o.method === 'insert').map((o) => o.args[0]);
const updates = (table: string) => ops.filter((o) => o.table === table && o.method === 'update').map((o) => o.args[0]);

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
  mockCalibracion.mockResolvedValue({ VIGENCIA_PAQUETE_MESES: 6 });
});

describe('§3.4 / §9.7: orden de consumo de los paquetes', () => {
  const lote = (id: string, vence_en: string | null, fecha_compra: string) => ({ id, vence_en, fecha_compra });
  const orden = (...lotes: ReturnType<typeof lote>[]) => [...lotes].sort(compararOrdenConsumo).map((l) => l.id);

  it('gana el que vence antes, aunque se haya comprado después', () => {
    expect(orden(lote('viejo', '2027-03-01T00:00:00Z', '2026-09-01T00:00:00Z'), lote('nuevo', '2027-01-01T00:00:00Z', '2026-09-20T00:00:00Z'))).toEqual([
      'nuevo',
      'viejo',
    ]);
  });

  it('si vencen el mismo día, primero la compra más antigua', () => {
    const vence = '2027-03-01T00:00:00Z';
    expect(orden(lote('b', vence, '2026-09-02T00:00:00Z'), lote('a', vence, '2026-09-01T00:00:00Z'))).toEqual(['a', 'b']);
  });

  it('los paquetes sin vencimiento (vendidos antes de la Adenda) van al final', () => {
    expect(orden(lote('perpetuo', null, '2026-01-01T00:00:00Z'), lote('vence', '2027-03-01T00:00:00Z', '2026-09-01T00:00:00Z'))).toEqual([
      'vence',
      'perpetuo',
    ]);
  });
});

describe('§3.1 / §9.6: vencimiento al acreditar', () => {
  it('meses de calendario; el día que no existe cae al último del mes', () => {
    expect(sumarMesesCalendario(new Date('2026-01-15T14:00:00Z'), 6).toISOString()).toBe('2026-07-15T14:00:00.000Z');
    expect(sumarMesesCalendario(new Date('2026-08-31T10:00:00Z'), 6).toISOString()).toBe('2027-02-28T10:00:00.000Z');
    expect(sumarMesesCalendario(new Date('2027-08-31T10:00:00Z'), 6).toISOString()).toBe('2028-02-29T10:00:00.000Z');
  });

  it('el lote vence VIGENCIA_PAQUETE_MESES meses después de aprobado el pago, aunque la compra no traiga vigencia', async () => {
    mockCalibracion.mockResolvedValue({ VIGENCIA_PAQUETE_MESES: 3 });
    enqueue(
      'compras_creditos_estudios',
      { data: { id: 'compra-1', perfil_id: 'owner-1', estado: 'pendiente', cantidad_estudios: 5, vence_en_dias: null }, error: null },
      { data: [{ id: 'compra-1' }], error: null }, // se reclama para el payment
      { data: [], error: null }, // saldo en contra
    );
    enqueue('lotes_creditos_estudios', { data: { id: 'lote-1' }, error: null }, { data: [{ cantidad_disponible: 5 }], error: null });

    const antes = new Date();
    await acreditarCompraDesdeWebhook('pref-1', 'mp-1', {});

    const lote = inserts('lotes_creditos_estudios')[0] as { vence_en: string };
    expect(Math.abs(Date.parse(lote.vence_en) - sumarMesesCalendario(antes, 3).getTime())).toBeLessThan(5_000);
  });
});

describe('§9.14: el catálogo de paquetes solo lo cambia la Gerencia General', () => {
  const admin = { id: 'admin-1', email: 'otro.admin@cofianza.co', rol: 'administrador' };
  const gerencia = { id: 'ger-1', email: 'gerencia@cofianza.co', rol: 'administrador' };

  it.each([
    ['crear', () => createPaquete({ nombre: 'X', cantidad_estudios: 5, precio_cop: 350000 }, admin)],
    ['editar', () => updatePaquete('paq-1', { precio_cop: 1 }, admin)],
    ['desactivar', () => deletePaquete('paq-1', admin)],
  ])('otro administrador no puede %s: 403 sin tocar la tabla', async (_accion, llamar) => {
    await expect(llamar()).rejects.toMatchObject({ statusCode: 403, errorCode: 'SOLO_GERENCIA_GENERAL' });
    expect(ops.filter((o) => o.table === 'paquetes_creditos_estudios')).toEqual([]);
  });

  it('la Gerencia edita y la traza guarda el valor anterior', async () => {
    enqueue(
      'paquetes_creditos_estudios',
      { data: { id: 'paq-1', nombre: 'Paquete 5', precio_cop: 350000, cantidad_estudios: 5, activo: true }, error: null },
      { data: { id: 'paq-1', precio_cop: 360000 }, error: null },
    );

    await updatePaquete('paq-1', { precio_cop: 360000 }, gerencia);

    expect(updates('paquetes_creditos_estudios')).toEqual([{ precio_cop: 360000 }]);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ usuarioId: 'ger-1', detalle: expect.objectContaining({ precio_cop: 360000, anterior: { precio_cop: 350000 } }) }),
    );
  });
});

describe('§3.8: detalle por paquete de la organización', () => {
  it('lee los lotes del titular, cuenta consumos menos devoluciones y ordena como se gastan', async () => {
    const ahora = Date.now();
    const iso = (dias: number) => new Date(ahora + dias * 86_400_000).toISOString();
    enqueue('lotes_creditos_estudios', {
      data: [
        { id: 'l-perp', compra_id: null, cantidad_inicial: 10, cantidad_disponible: 4, vence_en: null, origen: 'compra', created_at: iso(-300), updated_at: iso(-5) },
        { id: 'l-tarde', compra_id: 'c-2', cantidad_inicial: 5, cantidad_disponible: 5, vence_en: iso(150), origen: 'compra', created_at: iso(-30), updated_at: iso(-30) },
        { id: 'l-pronto', compra_id: 'c-1', cantidad_inicial: 10, cantidad_disponible: 7, vence_en: iso(20), origen: 'compra', created_at: iso(-160), updated_at: iso(-2) },
        { id: 'l-agotado', compra_id: 'c-3', cantidad_inicial: 5, cantidad_disponible: 0, vence_en: iso(60), origen: 'compra', created_at: iso(-120), updated_at: iso(-10) },
        { id: 'l-vencido', compra_id: null, cantidad_inicial: 5, cantidad_disponible: 2, vence_en: iso(-15), origen: 'ajuste_admin', created_at: iso(-200), updated_at: iso(-40) },
        { id: 'l-viejo', compra_id: null, cantidad_inicial: 5, cantidad_disponible: 1, vence_en: iso(-200), origen: 'compra', created_at: iso(-400), updated_at: iso(-300) },
      ],
      error: null,
    });
    enqueue('compras_creditos_estudios', {
      data: [
        { id: 'c-1', completed_at: iso(-160), created_at: iso(-161) },
        { id: 'c-2', completed_at: null, created_at: iso(-30) },
        { id: 'c-3', completed_at: iso(-120), created_at: iso(-120) },
      ],
      error: null,
    });
    enqueue('movimientos_creditos_estudios', {
      data: [
        ...Array.from({ length: 4 }, () => ({ lote_id: 'l-pronto', tipo: 'consumo', cantidad: -1, pago_id: 'p' })),
        { lote_id: 'l-pronto', tipo: 'ajuste', cantidad: 1, pago_id: 'p' }, // devolución
        { lote_id: 'l-agotado', tipo: 'ajuste', cantidad: -2, pago_id: null }, // contracargo: no es consumo
        ...Array.from({ length: 3 }, () => ({ lote_id: 'l-agotado', tipo: 'consumo', cantidad: -1, pago_id: 'p' })),
      ],
      error: null,
    });

    const detalle = await listDetallePaquetes('miembro-1');

    expect(ops.find((o) => o.table === 'lotes_creditos_estudios' && o.method === 'eq')?.args).toEqual(['perfil_id', 'owner-1']);
    expect(detalle.map((d) => [d.lote_id, d.estado])).toEqual([
      ['l-pronto', 'vigente'],
      ['l-tarde', 'vigente'],
      ['l-perp', 'vigente'],
      ['l-agotado', 'agotado'],
      ['l-vencido', 'vencido'],
    ]); // l-viejo venció hace más de 90 días: no sale
    expect(detalle[0]).toMatchObject({ comprados: 10, consumidos: 3, disponibles: 7, fecha_compra: iso(-160) });
    expect(detalle[1]).toMatchObject({ fecha_compra: iso(-30), consumidos: 0, disponibles: 5 });
    expect(detalle[3]).toMatchObject({ consumidos: 3, disponibles: 0 });
    expect(detalle[4]).toMatchObject({ disponibles: 0, fecha_compra: iso(-200) });
  });

  it('sin lotes no consulta nada más', async () => {
    enqueue('lotes_creditos_estudios', { data: [], error: null });
    expect(await listDetallePaquetes('owner-1')).toEqual([]);
    expect(ops.some((o) => o.table === 'movimientos_creditos_estudios')).toBe(false);
  });
});
