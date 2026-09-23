/**
 * Datos de la empresa: una lectura fallida no debe dejar un minuto los defaults
 * de company.ts, ni un guardado parcial escribirlos encima de los datos reales.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockFrom, ops, queues, enqueue } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const PASSTHROUGH = ['select', 'upsert', 'eq'];
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of PASSTHROUGH) {
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    }
    chain.maybeSingle = async () => next(table);
    chain.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  const mockFrom = vi.fn((table: string) => chainFor(table));
  const enqueue = (table: string, ...items: Res[]) => {
    queues.set(table, [...(queues.get(table) ?? []), ...items]);
  };
  return { mockFrom, ops, queues, enqueue };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t) } }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/config/company', () => ({
  COMPANY: {
    name: 'Default',
    nit: '000',
    address: 'Dir default',
    phone: '300 000 0000',
    email: 'default@x.co',
    website: 'x.co',
    certificateValidityDays: 60,
  },
}));

import { getCompany, setCompany, invalidateCompanyCache } from '@/lib/companyConfig';

const T = 'configuracion_sistema';
const fila = (v: Record<string, unknown>) => ({ data: { valor: JSON.stringify(v) }, error: null });

describe('companyConfig — lectura fallida', () => {
  let ahora = 1_000_000;
  beforeEach(() => {
    queues.clear();
    ops.length = 0;
    invalidateCompanyCache();
    vi.spyOn(Date, 'now').mockImplementation(() => ahora);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getCompany usa la ultima lectura buena si la base falla, y reintenta a los pocos segundos', async () => {
    enqueue(T, fila({ nit: '902.038.122-7' }));
    expect((await getCompany()).nit).toBe('902.038.122-7');

    ahora += 61_000;
    enqueue(T, { data: null, error: { message: 'timeout' } });
    expect((await getCompany()).nit).toBe('902.038.122-7'); // no el default

    ahora += 6_000;
    enqueue(T, fila({ nit: '111' }));
    expect((await getCompany()).nit).toBe('111');
  });

  it('setCompany mezcla sobre la fila, no sobre el respaldo del cache', async () => {
    enqueue(T, { data: null, error: { message: 'timeout' } });
    await getCompany(); // respaldo en cache
    enqueue(T, fila({ nit: '902.038.122-7', certificateValidityDays: 45 }));
    enqueue(T, { error: null }); // upsert

    await setCompany({ phone: '301' });

    const upsert = ops.find((o) => o.method === 'upsert')!;
    const guardado = JSON.parse((upsert.args[0] as { valor: string }).valor);
    expect(guardado).toMatchObject({ nit: '902.038.122-7', certificateValidityDays: 45, phone: '301' });
  });

  it('setCompany no guarda si no puede leer la fila', async () => {
    enqueue(T, { data: null, error: { message: 'timeout' } });

    await expect(setCompany({ phone: '301' })).rejects.toThrow('timeout');
    expect(ops.filter((o) => o.method === 'upsert')).toHaveLength(0);
  });
});
