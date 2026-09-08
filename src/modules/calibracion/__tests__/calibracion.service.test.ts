/**
 * Tablero de calibracion — Adenda 1 §2.4: porcentaje de estudios resueltos con
 * una sola central y con dos. La clasificacion lee la traza que
 * decidirConCascada deja en `estudios.cascada` (+ `proveedor_secundario`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFrom, ops, paginas } = vi.hoisted(() => {
  const ops: Array<{ method: string; args: unknown[] }> = [];
  // Cada `await` del builder consume la siguiente pagina de resultados.
  const paginas: Array<{ data: unknown; error: unknown }> = [];
  const PASSTHROUGH = ['select', 'eq', 'gte', 'order', 'range'];
  const chain: Record<string, unknown> = {};
  for (const m of PASSTHROUGH) {
    chain[m] = (...args: unknown[]) => {
      ops.push({ method: m, args });
      return chain;
    };
  }
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(paginas.shift() ?? { data: [], error: null }).then(resolve, reject);
  return { mockFrom: vi.fn(() => chain), ops, paginas };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t) } }));

import { clasificarCascada, resumenCascada } from '../calibracion.service';

describe('clasificarCascada (pura)', () => {
  it('dos centrales cuando la traza dice que se consulto la secundaria', () => {
    expect(
      clasificarCascada({
        cascada: { secundaria_consultada: true },
        proveedor_secundario: 'transunion',
      }),
    ).toBe('dos_centrales');
  });

  it('dos centrales tambien si solo quedo proveedor_secundario (la traza no se pudo persistir)', () => {
    expect(clasificarCascada({ cascada: null, proveedor_secundario: 'transunion' })).toBe(
      'dos_centrales',
    );
  });

  it('una central cuando hay traza y NO se consulto la secundaria', () => {
    expect(
      clasificarCascada({ cascada: { secundaria_consultada: false }, proveedor_secundario: null }),
    ).toBe('una_central');
  });

  it('sin dato cuando no hay traza (motor apagado / estudio anterior a la Adenda)', () => {
    expect(clasificarCascada({ cascada: null, proveedor_secundario: null })).toBe('sin_dato');
    expect(clasificarCascada({})).toBe('sin_dato');
  });
});

describe('resumenCascada', () => {
  beforeEach(() => {
    ops.length = 0;
    paginas.length = 0;
    mockFrom.mockClear();
  });

  it('cuenta por clase sobre estudios completados dentro de la ventana', async () => {
    paginas.push({
      data: [
        { id: '1', cascada: { secundaria_consultada: true }, proveedor_secundario: 'transunion' },
        { id: '2', cascada: { secundaria_consultada: false }, proveedor_secundario: null },
        { id: '3', cascada: { secundaria_consultada: false }, proveedor_secundario: null },
        { id: '4', cascada: null, proveedor_secundario: null },
      ],
      error: null,
    });

    const antes = Date.now();
    const r = await resumenCascada(30);

    expect(r).toMatchObject({ total: 4, una_central: 2, dos_centrales: 1, sin_dato: 1 });
    // `desde` = ahora - 30 dias (ISO).
    const desde = new Date(r.desde).getTime();
    expect(antes - desde).toBeGreaterThanOrEqual(30 * 24 * 60 * 60 * 1000 - 5);
    expect(antes - desde).toBeLessThan(30 * 24 * 60 * 60 * 1000 + 5000);
    // Filtro: solo completados y por fecha_completado >= desde.
    expect(mockFrom).toHaveBeenCalledWith('estudios');
    expect(ops.find((o) => o.method === 'eq')?.args).toEqual(['estado', 'completado']);
    expect(ops.find((o) => o.method === 'gte')?.args).toEqual(['fecha_completado', r.desde]);
    // Una sola pagina: menos de 1000 filas.
    expect(ops.filter((o) => o.method === 'range')).toHaveLength(1);
  });

  it('pagina de a 1000 para no truncar la muestra', async () => {
    const pagina = Array.from({ length: 1000 }, (_, i) => ({
      id: String(i),
      cascada: { secundaria_consultada: false },
    }));
    paginas.push(
      { data: pagina, error: null },
      { data: [{ id: 'x', cascada: null }], error: null },
    );

    const r = await resumenCascada(365);

    expect(r).toMatchObject({ total: 1001, una_central: 1000, sin_dato: 1, dos_centrales: 0 });
    const ranges = ops.filter((o) => o.method === 'range').map((o) => o.args);
    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it('un error de PostgREST sube como AppError (no se inventa un cero)', async () => {
    paginas.push({ data: null, error: { code: 'XX000', message: 'boom' } });
    await expect(resumenCascada(7)).rejects.toMatchObject({
      statusCode: 500,
      errorCode: 'DATABASE_ERROR',
    });
  });
});
