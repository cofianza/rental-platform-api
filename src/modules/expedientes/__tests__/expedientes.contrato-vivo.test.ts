/**
 * Acciones pendientes del inicio: el listado marca qué aprobados ya tienen
 * contrato vivo (antes el widget pedía GET /contratos después: otra petición
 * y dos idas más a Supabase).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queues, ops, mockRpc } = vi.hoisted(() => ({
  queues: new Map<string, Array<Record<string, unknown>>>(),
  ops: [] as Array<{ table: string; method: string; args: unknown[] }>,
  mockRpc: vi.fn(async (_fn: string, _params: Record<string, unknown>) => ({ data: { data: [], total: 0 }, error: null })),
}));

vi.mock('@/lib/supabase', () => {
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'neq', 'is', 'in']) {
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    }
    chain.then = (resolve: (v: unknown) => unknown) => resolve(queues.get(table)?.shift() ?? { data: null, error: null });
    return chain;
  };
  return {
    supabase: { from: (t: string) => chainFor(t), rpc: (fn: string, p: Record<string, unknown>) => mockRpc(fn, p), storage: { from: vi.fn() } },
  };
});
const { mockEnv } = vi.hoisted(() => ({
  mockEnv: new Proxy({} as Record<string, unknown>, {
    get: (_t, k) => (typeof k === 'string' && k.endsWith('_ENABLED') ? false : 'x'),
  }),
}));
vi.mock('@/config', () => ({ env: mockEnv }));
vi.mock('@/config/env', () => ({ env: mockEnv }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/tenantScope', () => ({ assertExpedienteAccess: vi.fn() }));
vi.mock('@/modules/firma/firma.service', () => ({ syncFirmaConAucoForExpediente: vi.fn() }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({ notificarYCorreo: vi.fn() }));
vi.mock('@/modules/whatsapp', () => ({ enviarTemplate: vi.fn() }));
vi.mock('@/modules/solicitantes/solicitantes.service', () => ({ getApplicantById: vi.fn() }));

import { listExpedientes } from '../expedientes.service';
import type { ListExpedientesQuery } from '../expedientes.schema';

const q = (o: Record<string, unknown>) => ({ page: 1, limit: 10, ...o }) as unknown as ListExpedientesQuery;

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
});

describe('listExpedientes con con_contrato_vivo', () => {
  it('marca tiene_contrato_vivo con una consulta de contratos no cancelados', async () => {
    mockRpc.mockResolvedValueOnce({ data: { data: [{ id: 'e1' }, { id: 'e2' }], total: 2 }, error: null });
    queues.set('contratos', [{ data: [{ expediente_id: 'e1' }], error: null }]);

    const r = await listExpedientes(q({ estado: 'aprobado', con_contrato_vivo: 'true' }), null);
    expect(r.expedientes).toEqual([
      { id: 'e1', tiene_contrato_vivo: true },
      { id: 'e2', tiene_contrato_vivo: false },
    ]);
    expect(ops).toContainEqual({ table: 'contratos', method: 'in', args: ['expediente_id', ['e1', 'e2']] });
    expect(ops).toContainEqual({ table: 'contratos', method: 'neq', args: ['estado', 'cancelado'] });
  });

  it('si la consulta de contratos falla, las filas salen sin el campo', async () => {
    mockRpc.mockResolvedValueOnce({ data: { data: [{ id: 'e1' }], total: 1 }, error: null });
    queues.set('contratos', [{ data: null, error: { message: 'boom' } }]);
    const r = await listExpedientes(q({ con_contrato_vivo: 'true' }), null);
    expect(r.expedientes).toEqual([{ id: 'e1' }]);
  });

  it('sin el parámetro no consulta contratos', async () => {
    mockRpc.mockResolvedValueOnce({ data: { data: [{ id: 'e1' }], total: 1 }, error: null });
    await listExpedientes(q({}), null);
    expect(ops).toEqual([]);
  });
});
