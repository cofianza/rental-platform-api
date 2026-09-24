import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// P27: en Fase 3 el caso es de Cofianza y el dueño solo anota en el historial.
// Esa nota le tiene que llegar a Cofianza y, si reporta un pago, el WhatsApp
// de Fase 3 que esté esperando queda en pausa hasta que Cofianza lo revise.
// ============================================================

const { mockFrom, ops, enqueue, resetQueues, mockNotificar } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'update', 'eq', 'not', 'order']) {
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    }
    chain.single = async () => next(table);
    chain.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  return {
    mockFrom: vi.fn((table: string) => chainFor(table)),
    ops,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    resetQueues: () => queues.clear(),
    mockNotificar: vi.fn(),
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t) } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/config', () => ({ env: {} }));
vi.mock('../../whatsapp', () => ({ enviarTemplate: vi.fn() }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({ notificarUsuario: mockNotificar }));
vi.mock('@/modules/users/users.service', () => ({ listOperators: async () => [{ id: 'op1' }] }));
vi.mock('@/lib/tenantScope', () => ({
  assertExpedienteAccess: vi.fn(),
  resolveAllowedExpedienteIds: async () => null,
}));

import { agregarMensaje, reanudarWhatsApp } from '../moras.service';

const mora = (estado: string) => ({
  data: {
    id: 'm1', ticket_numero: 'MOR-2026-007', estado, expediente_id: 'exp1', reportado_por: 'dueno',
    reportado_at: '2026-09-01T12:00:00Z', fecha_vencimiento_canon: '2026-09-05',
    inquilino_telefono: '3001112233', inquilino_nombre: 'Ana Pérez', inmueble_direccion: 'Cra 7', monto_mora: 1_500_000,
  },
  error: null,
});
const avisos = () => mockNotificar.mock.calls.map((c) => c[0] as { userId: string; tipo: string; mensaje: string });
const pausas = () =>
  ops.filter((o) => o.table === 'moras_tickets' && o.method === 'update' && 'whatsapp_pausado_at' in (o.args[0] as object));

beforeEach(() => {
  resetQueues();
  ops.length = 0;
  mockNotificar.mockClear();
});

describe('agregarMensaje en Fase 3 (P27)', () => {
  it('el dueño reporta un pago: Cofianza se entera y el WhatsApp de Fase 3 queda en pausa', async () => {
    enqueue('moras_tickets', mora('fase_3'), { data: [{ id: 'm1' }], error: null }); // acceso, pausa (1 fila)
    enqueue('moras_mensajes', { data: { id: 'msg1' }, error: null });

    await agregarMensaje('m1', { mensaje: 'Me pagó en efectivo', via_whatsapp: false, reporta_pago: true }, 'dueno', 'inmobiliaria');

    expect(pausas()).toHaveLength(1);
    expect(ops).toContainEqual({ table: 'moras_tickets', method: 'not', args: ['whatsapp_programado_para', 'is', null] });
    expect(avisos()).toEqual([
      expect.objectContaining({ userId: 'op1', tipo: 'mora.pago_reportado', mensaje: expect.stringContaining('quedó en pausa') }),
    ]);
  });

  it('una nota sin pago también le llega a Cofianza, sin pausar nada', async () => {
    enqueue('moras_tickets', mora('fase_3'));
    enqueue('moras_mensajes', { data: { id: 'msg1' }, error: null });

    await agregarMensaje('m1', { mensaje: 'Dice que paga el viernes', via_whatsapp: false, reporta_pago: false }, 'dueno', 'propietario');

    expect(pausas()).toEqual([]);
    expect(avisos()).toEqual([expect.objectContaining({ tipo: 'mora.nota_dueno' })]);
  });

  it('en Fases 1-2, o si escribe Cofianza, no hay aviso', async () => {
    enqueue('moras_tickets', mora('fase_2'), mora('fase_3'));
    enqueue('moras_mensajes', { data: { id: 'a' }, error: null }, { data: { id: 'b' }, error: null });

    await agregarMensaje('m1', { mensaje: 'nota', via_whatsapp: false, reporta_pago: true }, 'dueno', 'inmobiliaria');
    await agregarMensaje('m1', { mensaje: 'nota', via_whatsapp: false, reporta_pago: true }, 'op', 'operador_analista');

    expect(pausas()).toEqual([]);
    expect(avisos()).toEqual([]);
  });
});

describe('reanudarWhatsApp', () => {
  it('quita la pausa y lo deja dicho; si no estaba en pausa, 409', async () => {
    enqueue('moras_tickets', mora('fase_3'), { data: [{ id: 'm1' }], error: null }, { data: { id: 'm1' }, error: null });
    await reanudarWhatsApp('m1', 'op', 'operador_analista');
    expect(pausas()).toEqual([expect.objectContaining({ args: [{ whatsapp_pausado_at: null }] })]);

    enqueue('moras_tickets', mora('fase_3'), { data: [], error: null });
    await expect(reanudarWhatsApp('m1', 'op', 'operador_analista')).rejects.toMatchObject({ statusCode: 409 });
  });
});
