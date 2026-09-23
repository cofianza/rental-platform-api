import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Hero "Tu Oficina Virtual": «Propiedades activas» contaba también los
// inmuebles dados de baja (estado 'inactivo'), que el listado ya no muestra.
// Mock de Supabase con colas por tabla + `ops`.
// ============================================================

const { ops, enqueue, queues, chainFor } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null, count: null };
  };
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'neq', 'in']) {
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    }
    chain.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  const enqueue = (table: string, ...items: Res[]) => {
    queues.set(table, [...(queues.get(table) ?? []), ...items]);
  };
  return { ops, enqueue, queues, chainFor };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => chainFor(t) } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/tenantScope', () => ({ resolvePortfolioInmuebleIds: async () => ['i1', 'i2', 'i3'] }));

import { getPortfolioStats } from '../dashboard.service';

beforeEach(() => {
  ops.length = 0;
  queues.clear();
});

describe('getPortfolioStats', () => {
  it('«Propiedades activas» no cuenta los inmuebles dados de baja', async () => {
    enqueue('expedientes', { data: [], error: null });
    enqueue('inmuebles', { count: 2, error: null });

    const stats = await getPortfolioStats('p1');

    expect(stats.propiedades_activas).toBe(2);
    expect(ops).toContainEqual({ table: 'inmuebles', method: 'neq', args: ['estado', 'inactivo'] });
  });
});
