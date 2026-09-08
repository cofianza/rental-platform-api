/**
 * setParametro — Adenda 1 §11: "todo cambio debe quedar registrado".
 * SIN HISTORIAL NO HAY CAMBIO: el rastro se escribe primero; si falla, el valor
 * no se toca. Si el valor falla despues, el rastro recien escrito se retira.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFrom, ops, queues, enqueue } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'order', 'limit'];
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of PASSTHROUGH) {
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    }
    chain.single = async () => next(table);
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
vi.mock('@/config', () => ({ env: { CANON_MAXIMO_SIN_COAFIANZAMIENTO_COP: 3_000_000 } }));

import { setParametro, invalidateCalibracionCache } from '@/lib/calibracion';

const USER = '660e8400-e29b-41d4-a716-446655440000';
const opsDe = (table: string, method: string) =>
  ops.filter((o) => o.table === table && o.method === method);

describe('setParametro — sin historial no hay cambio (Adenda §11)', () => {
  beforeEach(() => {
    queues.clear();
    ops.length = 0;
    mockFrom.mockClear();
    invalidateCalibracionCache();
  });

  it('camino feliz: escribe el historial PRIMERO y despues el valor', async () => {
    enqueue('parametros_calibracion', { data: [], error: null }); // getCalibracion (valor anterior)
    enqueue('parametros_calibracion_historial', { data: { id: 'h1' }, error: null });
    enqueue('parametros_calibracion', { error: null }); // upsert

    const fila = await setParametro('DIAS_EXPIRACION_ESTUDIO', 20, USER, 'prueba');

    expect(fila).toMatchObject({
      clave: 'DIAS_EXPIRACION_ESTUDIO',
      valor: 20,
      actualizado_por: USER,
    });
    const iHist = ops.findIndex(
      (o) => o.table === 'parametros_calibracion_historial' && o.method === 'insert',
    );
    const iUpsert = ops.findIndex(
      (o) => o.table === 'parametros_calibracion' && o.method === 'upsert',
    );
    expect(iHist).toBeGreaterThanOrEqual(0);
    expect(iUpsert).toBeGreaterThan(iHist);
    expect(opsDe('parametros_calibracion_historial', 'insert')[0].args[0]).toMatchObject({
      clave: 'DIAS_EXPIRACION_ESTUDIO',
      valor_anterior: 15,
      valor_nuevo: 20,
      usuario_id: USER,
      motivo: 'prueba',
    });
    expect(opsDe('parametros_calibracion_historial', 'delete')).toHaveLength(0);
  });

  it('si el historial falla, lanza 500 y NO toca el valor', async () => {
    enqueue('parametros_calibracion', { data: [], error: null });
    enqueue('parametros_calibracion_historial', { data: null, error: { message: 'tabla caida' } });

    await expect(setParametro('DIAS_EXPIRACION_ESTUDIO', 20, USER)).rejects.toMatchObject({
      statusCode: 500,
      errorCode: 'CALIBRACION_HISTORIAL_ERROR',
    });
    expect(opsDe('parametros_calibracion', 'upsert')).toHaveLength(0);
  });

  it('si el valor falla despues del historial, retira el rastro recien escrito y propaga', async () => {
    enqueue('parametros_calibracion', { data: [], error: null });
    enqueue('parametros_calibracion_historial', { data: { id: 'h1' }, error: null });
    enqueue('parametros_calibracion', { error: { message: 'upsert fallo' } });

    await expect(setParametro('DIAS_EXPIRACION_ESTUDIO', 20, USER)).rejects.toMatchObject({
      statusCode: 500,
      errorCode: 'CALIBRACION_GUARDAR_ERROR',
    });
    expect(opsDe('parametros_calibracion_historial', 'delete')).toHaveLength(1);
    const eqTrasDelete = ops.filter(
      (o) => o.table === 'parametros_calibracion_historial' && o.method === 'eq',
    );
    expect(eqTrasDelete.at(-1)?.args).toEqual(['id', 'h1']);
  });

  it('sigue rechazando clave desconocida y valor fuera de rango sin tocar la base', async () => {
    await expect(setParametro('NO_EXISTE', 1, USER)).rejects.toThrow(/desconocido/);
    await expect(setParametro('DIAS_EXPIRACION_ESTUDIO', 1000, USER)).rejects.toThrow(
      /Fuera de rango/,
    );
    expect(opsDe('parametros_calibracion_historial', 'insert')).toHaveLength(0);
  });
});
