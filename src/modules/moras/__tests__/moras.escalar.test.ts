import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================
// Escalado manual y cola de moras. El escalado escribe condicionado a la fase
// leída (como el cron): dos escalados a la vez, o una pantalla vieja, no le
// mandan al inquilino dos plantillas ni una fase que nadie pidió. La cola
// «activas» con orden ascendente no deja fuera las moras más viejas.
// Mismo mock de Supabase con colas por tabla que moras.acceso.test.
// ============================================================

const { mockFrom, ops, enqueue, resetQueues, mockEnviarTemplate } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null, count: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'update', 'eq', 'in', 'order', 'range', 'limit'];
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
    enqueue: (table: string, ...items: Res[]) => {
      queues.set(table, [...(queues.get(table) ?? []), ...items]);
    },
    resetQueues: () => queues.clear(),
    mockEnviarTemplate: vi.fn(async () => ({ estado: 'enviado' })),
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t) } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/config', () => ({ env: {} })); // plantillas de mora v2 (P28) apagadas
vi.mock('../../whatsapp', () => ({ enviarTemplate: mockEnviarTemplate }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({ notificarUsuario: vi.fn() }));
vi.mock('@/modules/users/users.service', () => ({ listOperators: async () => [] }));
vi.mock('@/lib/tenantScope', () => ({
  assertExpedienteAccess: vi.fn(),
  resolveAllowedExpedienteIds: async () => null,
}));

import { escalarMora, listMoras, marcarPagada, cancelarMora } from '../moras.service';

const mora = (estado: string, reportado_at = '2026-09-01T00:00:00Z') => ({
  data: {
    id: 'm1', ticket_numero: 'MOR-1', estado, expediente_id: 'exp1', reportado_por: 'u1',
    reportado_at, fecha_vencimiento_canon: '2026-09-05',
    inquilino_telefono: '573001112233', inquilino_nombre: 'Ana Pérez',
    inmueble_direccion: 'Cra 7 # 45-10', monto_mora: 1500000,
  },
  error: null,
});

beforeEach(() => {
  // Martes 10 a. m. en Colombia: dentro del horario de cobranza (Ley 2300).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-29T10:00:00-05:00'));
  resetQueues();
  ops.length = 0;
  mockEnviarTemplate.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('escalarMora', () => {
  it('si otro ya movió la fila (update sin filas), responde 409 y no manda el WhatsApp', async () => {
    enqueue('moras_tickets', mora('fase_1'), { data: [], error: null });
    await expect(escalarMora('m1', {}, 'op', 'operador_analista')).rejects.toMatchObject({ statusCode: 409 });
    const upd = ops.filter((o) => o.table === 'moras_tickets' && o.method === 'eq').map((o) => o.args);
    expect(upd).toContainEqual(['estado', 'fase_1']);
    expect(mockEnviarTemplate).not.toHaveBeenCalled();
  });

  it('con la pantalla vieja (desde fase_1 pero ya está en fase_2) no salta a Fase 3', async () => {
    enqueue('moras_tickets', mora('fase_2'));
    await expect(
      escalarMora('m1', { desde: 'fase_1' }, 'op', 'operador_analista'),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(ops.filter((o) => o.method === 'update')).toEqual([]);
    expect(mockEnviarTemplate).not.toHaveBeenCalled();
  });

  it('el camino normal escala y manda una sola plantilla', async () => {
    enqueue('moras_tickets',
      mora('fase_1'),
      { data: [{ id: 'm1' }], error: null },   // update → 1 fila
      { data: null, error: null },             // whatsapp_programado_para → null (sale ya)
      { data: { id: 'm1' }, error: null },     // getMoraById
    );
    await escalarMora('m1', { desde: 'fase_1' }, 'op', 'operador_analista');
    expect(mockEnviarTemplate).toHaveBeenCalledTimes(1);
  });
});

describe('P27: qué decide el dueño y qué decide Cofianza', () => {
  const hace = (dias: number) => new Date(Date.now() - dias * 86_400_000).toISOString();
  const updates = () => ops.filter((o) => o.method === 'update');

  it('el dueño no escala a Fase 3', async () => {
    enqueue('moras_tickets', mora('fase_2'));
    await expect(escalarMora('m1', {}, 'p1', 'propietario')).rejects.toMatchObject({ statusCode: 403 });
    expect(updates()).toEqual([]);
    expect(mockEnviarTemplate).not.toHaveBeenCalled();
  });

  it('el dueño escala a Fase 2 desde el día 4 del reporte; Cofianza cuando quiera', async () => {
    enqueue('moras_tickets', mora('fase_1', hace(2)));
    await expect(escalarMora('m1', {}, 'p1', 'inmobiliaria')).rejects.toMatchObject({ statusCode: 400 });
    expect(updates()).toEqual([]);

    // Estos pasan la regla y llegan al UPDATE (que aquí no mueve filas → 409).
    enqueue('moras_tickets', mora('fase_1', hace(5)), { data: [], error: null });
    await expect(escalarMora('m1', {}, 'p1', 'inmobiliaria')).rejects.toMatchObject({ statusCode: 409 });
    enqueue('moras_tickets', mora('fase_1', hace(0)), { data: [], error: null });
    await expect(escalarMora('m1', {}, 'op', 'operador_analista')).rejects.toMatchObject({ statusCode: 409 });
    expect(updates()).toHaveLength(2);
  });

  it('en Fase 3 el dueño no la marca pagada ni la cancela; Cofianza sí', async () => {
    enqueue('moras_tickets', mora('fase_3'), mora('fase_3'));
    await expect(marcarPagada('m1', {}, 'p1', 'propietario')).rejects.toMatchObject({ statusCode: 403 });
    await expect(cancelarMora('m1', { motivo: 'pagó' }, 'p1', 'propietario')).rejects.toMatchObject({ statusCode: 403 });
    expect(updates()).toEqual([]);

    enqueue('moras_tickets', mora('fase_3'), { data: null, error: null }, { data: { id: 'm1' }, error: null });
    await marcarPagada('m1', {}, 'op', 'operador_analista');
    expect(updates()).toHaveLength(1);
  });
});

describe('listMoras', () => {
  it('«activas» filtra fase_1..3 y ordena de la más vieja a la más reciente', async () => {
    enqueue('moras_tickets', { data: [], error: null, count: 0 });
    await listMoras({ estado: 'activas', orden: 'asc', page: 1, limit: 100 }, 'op', 'operador_analista');
    const t = ops.filter((o) => o.table === 'moras_tickets');
    expect(t.filter((o) => o.method === 'in').map((o) => o.args)).toEqual([['estado', ['fase_1', 'fase_2', 'fase_3']]]);
    expect(t.filter((o) => o.method === 'eq')).toEqual([]);
    expect(t.find((o) => o.method === 'order')?.args).toEqual(['reportado_at', { ascending: true }]);
  });
});
