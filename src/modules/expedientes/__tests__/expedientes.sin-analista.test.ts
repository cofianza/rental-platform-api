/**
 * «Sin asignar» del dashboard del analista: el filtro va al API (antes la web
 * pedía 30 pendientes y filtraba en el navegador, y con los 30 más viejos ya
 * asignados decía que no había huérfanos). Los ids sin analista entran por el
 * filtro de ids del RPC, cruzados con el scope.
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

describe('listExpedientes con sin_analista', () => {
  it('rol interno: el RPC recibe solo los ids sin analista de esos estados', async () => {
    queues.set('expedientes', [{ data: [{ id: 'a' }, { id: 'b' }], error: null }]);
    await listExpedientes(q({ sin_analista: 'true', estado: 'borrador,en_revision' }), null);

    expect(ops).toContainEqual({ table: 'expedientes', method: 'is', args: ['analista_id', null] });
    expect(ops).toContainEqual({ table: 'expedientes', method: 'in', args: ['estado', ['borrador', 'en_revision']] });
    expect(mockRpc.mock.calls[0][1].p_allowed_expediente_ids).toEqual(['a', 'b']);
  });

  it('rol con scope: cruza con los ids permitidos', async () => {
    queues.set('expedientes', [{ data: [{ id: 'a' }, { id: 'b' }], error: null }]);
    await listExpedientes(q({ sin_analista: 'true' }), ['b', 'c']);
    expect(mockRpc.mock.calls[0][1].p_allowed_expediente_ids).toEqual(['b']);
  });

  it('sin huérfanos: lista vacía sin llamar al RPC', async () => {
    queues.set('expedientes', [{ data: [], error: null }]);
    await expect(listExpedientes(q({ sin_analista: 'true' }), null)).resolves.toMatchObject({ expedientes: [], pagination: { total: 0 } });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('sin el filtro no hay consulta extra', async () => {
    await listExpedientes(q({}), null);
    expect(ops).toEqual([]);
    expect(mockRpc.mock.calls[0][1]).not.toHaveProperty('p_allowed_expediente_ids');
  });
});
