import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Acceso a las moras: son del ESTUDIO, no de quien las reportó. Se ven y se
// gestionan por el alcance de tenantScope (el mismo del estudio), así que un
// miembro que salió del equipo deja de verlas, el equipo no pierde las que él
// reportó y nadie lee ni reporta la mora de otra agencia por UUID.
// Mismo mock de Supabase con colas por tabla que moras.autoescalar.test.
// ============================================================

const { mockFrom, ops, enqueue, resetQueues, mockEnviarTemplate, mockAssertAccess, mockAllowed } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null, count: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'update', 'eq', 'in', 'order', 'range'];
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
    mockAssertAccess: vi.fn(),
    mockAllowed: vi.fn(),
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t) } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../whatsapp', () => ({ enviarTemplate: mockEnviarTemplate }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({ notificarUsuario: vi.fn() }));
vi.mock('@/modules/users/users.service', () => ({ listOperators: async () => [] }));
vi.mock('@/lib/tenantScope', () => ({
  assertExpedienteAccess: (...a: unknown[]) => mockAssertAccess(...a),
  resolveAllowedExpedienteIds: (...a: unknown[]) => mockAllowed(...a),
}));

import { AppError } from '@/lib/errors';
import { listMoras, obtenerMora, reportarMora } from '../moras.service';

const fuera = () => {
  throw AppError.notFound('Estudio no encontrado');
};

beforeEach(() => {
  resetQueues();
  ops.length = 0;
  mockEnviarTemplate.mockClear();
  mockAssertAccess.mockReset();
  mockAllowed.mockReset();
});

describe('acceso a las moras', () => {
  it('el detalle de una mora de un estudio ajeno responde 404 (antes cualquiera la leía por UUID)', async () => {
    enqueue('moras_tickets', { data: { id: 'm1', estado: 'fase_1', expediente_id: 'exp-otro', reportado_por: 'u1' }, error: null });
    mockAssertAccess.mockImplementation(fuera);
    await expect(obtenerMora('m1', 'u2', 'inmobiliaria')).rejects.toMatchObject({ statusCode: 404 });
    expect(mockAssertAccess).toHaveBeenCalledWith('exp-otro', 'u2', 'inmobiliaria');
  });

  it('quien ve el estudio ve la mora aunque la haya reportado otro miembro', async () => {
    enqueue('moras_tickets',
      { data: { id: 'm1', estado: 'fase_1', expediente_id: 'exp1', reportado_por: 'ex-miembro' }, error: null },
      { data: { id: 'm1' }, error: null },
    );
    mockAssertAccess.mockResolvedValue(undefined);
    await expect(obtenerMora('m1', 'titular', 'inmobiliaria')).resolves.toMatchObject({ id: 'm1' });
  });

  it('no se reporta una mora sobre el contrato de otra agencia: 404 sin insertar ni escribir por WhatsApp', async () => {
    enqueue('contratos', { data: { id: 'c1', expediente_id: 'exp-otro', estado: 'vigente' }, error: null });
    enqueue('expedientes', { data: { id: 'exp-otro', solicitante_id: null, inmueble_id: 'i1' }, error: null });
    enqueue('inmuebles', { data: { codigo: 'A1', direccion: 'Cra 1', propietario_id: 'otro' }, error: null });
    mockAssertAccess.mockImplementation(fuera);
    await expect(
      reportarMora({ contrato_id: 'c1', monto_mora: 1_000_000, fecha_vencimiento_canon: '2026-09-05' } as never, 'u2', 'inmobiliaria'),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(ops.filter((o) => o.method === 'insert')).toEqual([]);
    expect(mockEnviarTemplate).not.toHaveBeenCalled();
  });

  it('la lista filtra por los estudios visibles, no por quién reportó', async () => {
    mockAllowed.mockResolvedValue(['exp1', 'exp2']);
    enqueue('moras_tickets', { data: [], error: null, count: 0 });
    await listMoras({ page: 1, limit: 20 } as never, 'u1', 'inmobiliaria');
    const filtros = ops.filter((o) => o.table === 'moras_tickets' && o.method === 'in').map((o) => o.args);
    expect(filtros).toEqual([['expediente_id', ['exp1', 'exp2']]]);
  });

  it('sin estudios visibles (p. ej. un ex-miembro) la lista sale vacía sin consultar', async () => {
    mockAllowed.mockResolvedValue([]);
    const r = await listMoras({ page: 1, limit: 20 } as never, 'ex', 'inmobiliaria');
    expect(r.data).toEqual([]);
    expect(ops.filter((o) => o.method === 'range')).toEqual([]);
  });
});
