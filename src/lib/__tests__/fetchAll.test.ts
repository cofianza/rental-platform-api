import { describe, it, expect, vi, beforeEach } from 'vitest';

// PostgREST corta cada respuesta en 1000 filas: los KPIs, reportes y
// exportaciones que cuentan en JS se congelaban ahi.

const { paginas, rangos } = vi.hoisted(() => ({
  paginas: [] as Array<{ data: unknown[] | null; error: unknown }>,
  rangos: [] as Array<[number, number]>,
}));

vi.mock('@/lib/supabase', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'in', 'order', 'gte', 'lte']) chain[m] = () => chain;
  chain.range = (desde: number, hasta: number) => {
    rangos.push([desde, hasta]);
    return Promise.resolve(paginas.shift() ?? { data: [], error: null });
  };
  return { supabase: { from: () => chain } };
});
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { fetchAll } from '../fetchAll';
import { supabase } from '@/lib/supabase';

const filas = (n: number, estado = 'vigente') => Array.from({ length: n }, () => ({ estado }));
const pagina = (desde: number, hasta: number) =>
  (supabase.from('contratos' as never) as unknown as { range: (a: number, b: number) => Promise<{ data: { estado: string }[] | null; error: null }> }).range(desde, hasta);

beforeEach(() => {
  paginas.length = 0;
  rangos.length = 0;
});

describe('fetchAll', () => {
  it('sigue pidiendo paginas hasta una incompleta', async () => {
    paginas.push({ data: filas(1000), error: null }, { data: filas(1000), error: null }, { data: filas(5), error: null });
    const { data, error } = await fetchAll(pagina);
    expect(error).toBeNull();
    expect(data).toHaveLength(2005);
    expect(rangos).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it('con tope corta sin pedir de mas (la exportacion pide 10001 para saber si trunco)', async () => {
    paginas.push({ data: filas(1000), error: null }, { data: filas(1000), error: null });
    const { data } = await fetchAll(pagina, 1500);
    expect(data).toHaveLength(1500);
    expect(rangos).toHaveLength(2);
  });

  it('un error de PostgREST se devuelve, no se traga', async () => {
    paginas.push({ data: filas(1000), error: null }, { data: null, error: { code: 'XX000', message: 'boom' } });
    const { error } = await fetchAll(pagina);
    expect(error).toMatchObject({ code: 'XX000' });
  });
});

describe('reporte de aprobacion con mas de 1000 estudios resueltos', () => {
  it('el total no se congela en 1000', async () => {
    const { getAprobacionExpedientes } = await import('@/modules/reportes/reportes.service');
    const fila = (estado: string) => ({ id: 'x', estado, created_at: '2026-09-10T12:00:00Z' });
    paginas.push(
      { data: Array.from({ length: 1000 }, () => fila('aprobado')), error: null },
      { data: [fila('rechazado')], error: null },
    );
    const r = await getAprobacionExpedientes('2026-09-01T00:00:00Z', '2026-09-30T23:59:59Z');
    expect(r.totales.total_resueltos).toBe(1001);
    expect(r.totales.total_rechazados).toBe(1);
  });
});
