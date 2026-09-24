import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================
// Cron de auto-escalado de moras. Lo que se cuida aquí es que un inquilino
// real no reciba dos WhatsApp seguidos: ni el salto fase_1 → fase_3 en una
// sola corrida, ni el reenvío cuando el UPDATE no afectó ninguna fila.
//
// Mismo mock de Supabase que autorizaciones: builder encadenable + colas por
// tabla; `ops` guarda todo lo que se llamó para poder afirmar QUE se filtró.
// ============================================================

const { mockFrom, ops, enqueue, resetQueues, mockEnviarTemplate } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null, count: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'is', 'not', 'in', 'or', 'lt', 'gt', 'gte', 'lte', 'order', 'limit'];
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
vi.mock('../../whatsapp', () => ({ enviarTemplate: mockEnviarTemplate }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({ notificarUsuario: vi.fn() }));
vi.mock('@/modules/users/users.service', () => ({ listOperators: async () => [] }));

import { autoEscalar } from '../moras.service';

const mora = (id: string, diasDesdeReporte: number) => ({
  id,
  inquilino_telefono: '573001112233',
  inquilino_nombre: 'Ana Pérez',
  inmueble_direccion: 'Cra 7 # 45-10',
  monto_mora: 1500000,
  reportado_at: new Date(Date.now() - diasDesdeReporte * 86400000).toISOString(),
  fecha_vencimiento_canon: '2026-09-05',
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

describe('autoEscalar', () => {
  it('una mora vieja en fase_1 sube a fase_2 y NO salta a fase_3 en la misma corrida', async () => {
    // Reportada hace 12 días y todavía en fase_1: cumple el corte de los 10
    // días, así que sin el filtro por fase_2_at saldría también en la consulta
    // de fase 3.
    enqueue('moras_tickets',
      { data: [], error: null },                      // WhatsApp programados → ninguno
      { data: [mora('m1', 12)], error: null },        // select fase_1
      { data: [{ id: 'm1' }], error: null },          // update → fase_2 (1 fila)
      { data: [], error: null },                      // moras del teléfono (sin gestión previa)
      { data: null, error: null },                    // whatsapp_programado_para → null
      { data: [], error: null },                      // select fase_2 → vacío
    );

    const r = await autoEscalar();

    expect(r).toEqual({ aFase2: 1, aFase3: 0, cobrosProgramados: 0 });
    expect(mockEnviarTemplate).toHaveBeenCalledTimes(1);
    expect(mockEnviarTemplate.mock.calls[0][0]).toMatchObject({ template: 'MORA_FASE_2' });

    // La consulta de fase 3 exige permanencia en fase_2, no solo antigüedad.
    const lte = ops.filter((o) => o.method === 'lte').map((o) => o.args[0]);
    expect(lte).toContain('fase_2_at');
  });

  it('el UPDATE es condicional al estado: si no afectó filas no manda WhatsApp', async () => {
    enqueue('moras_tickets',
      { data: [], error: null },                      // WhatsApp programados → ninguno
      { data: [mora('m2', 5)], error: null },         // select fase_1
      { data: [], error: null },                      // update no afectó nada (otra corrida ya la movió)
      { data: [], error: null },                      // select fase_2 → vacío
    );

    const r = await autoEscalar();

    expect(r).toEqual({ aFase2: 0, aFase3: 0, cobrosProgramados: 0 });
    expect(mockEnviarTemplate).not.toHaveBeenCalled();

    const updateEqs = ops
      .filter((o) => o.method === 'eq' && o.args[0] === 'estado')
      .map((o) => o.args[1]);
    expect(updateEqs).toContain('fase_1');
  });

  it('una mora con 6 días en fase_2 sí escala a fase_3', async () => {
    enqueue('moras_tickets',
      { data: [], error: null },                      // WhatsApp programados → ninguno
      { data: [], error: null },                      // select fase_1 → vacío
      { data: [mora('m3', 12)], error: null },        // select fase_2
      { data: [{ id: 'm3' }], error: null },          // update → fase_3 (1 fila)
      { data: [], error: null },                      // moras del teléfono (sin gestión previa)
    );

    const r = await autoEscalar();

    expect(r).toEqual({ aFase2: 0, aFase3: 1, cobrosProgramados: 0 });
    expect(mockEnviarTemplate).toHaveBeenCalledTimes(1);
    expect(mockEnviarTemplate.mock.calls[0][0]).toMatchObject({ template: 'MORA_FASE_3' });
  });
});
