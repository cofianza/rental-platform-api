/**
 * setParametro — Adenda 1 §11: "todo cambio debe quedar registrado".
 * SIN HISTORIAL NO HAY CAMBIO: el rastro se escribe primero; si falla, el valor
 * no se toca. Si el valor falla despues, el rastro recien escrito se retira.
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

import {
  setParametro,
  invalidateCalibracionCache,
  getCalibracion,
  validarCoherencia,
  CALIBRACION_DEFAULT,
} from '@/lib/calibracion';

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

describe('lectura fallida — no se queda un minuto con los defaults', () => {
  let ahora = 1_000_000;
  beforeEach(() => {
    queues.clear();
    ops.length = 0;
    invalidateCalibracionCache();
    vi.spyOn(Date, 'now').mockImplementation(() => ahora);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('si la base falla usa la ultima lectura buena, y reintenta a los pocos segundos', async () => {
    enqueue('parametros_calibracion', { data: [{ clave: 'DIAS_EXPIRACION_ESTUDIO', valor: 30 }], error: null });
    expect((await getCalibracion()).DIAS_EXPIRACION_ESTUDIO).toBe(30);

    ahora += 61_000;
    enqueue('parametros_calibracion', { data: null, error: { message: 'timeout' } });
    expect((await getCalibracion()).DIAS_EXPIRACION_ESTUDIO).toBe(30); // no el default (15)

    ahora += 6_000;
    enqueue('parametros_calibracion', { data: [{ clave: 'DIAS_EXPIRACION_ESTUDIO', valor: 40 }], error: null });
    expect((await getCalibracion()).DIAS_EXPIRACION_ESTUDIO).toBe(40);
  });

  it('setParametro registra como anterior el valor de la tabla, no el respaldo del cache', async () => {
    enqueue('parametros_calibracion', { data: null, error: { message: 'timeout' } });
    await getCalibracion(); // deja el respaldo en cache
    enqueue('parametros_calibracion', { data: [{ clave: 'DIAS_EXPIRACION_ESTUDIO', valor: 20 }], error: null });
    enqueue('parametros_calibracion_historial', { data: { id: 'h1' }, error: null });
    enqueue('parametros_calibracion', { error: null });

    await setParametro('DIAS_EXPIRACION_ESTUDIO', 25, USER);

    expect(opsDe('parametros_calibracion_historial', 'insert')[0].args[0]).toMatchObject({
      valor_anterior: 20,
      valor_nuevo: 25,
    });
  });

  it('setParametro no escribe nada si no puede leer el valor vigente', async () => {
    enqueue('parametros_calibracion', { data: null, error: { message: 'timeout' } });

    await expect(setParametro('DIAS_EXPIRACION_ESTUDIO', 25, USER)).rejects.toMatchObject({
      statusCode: 500,
      errorCode: 'CALIBRACION_LECTURA_ERROR',
    });
    expect(opsDe('parametros_calibracion_historial', 'insert')).toHaveLength(0);
    expect(opsDe('parametros_calibracion', 'upsert')).toHaveLength(0);
  });
});

describe('umbrales cruzados — el panel no deja guardarlos', () => {
  beforeEach(() => {
    queues.clear();
    ops.length = 0;
    invalidateCalibracionCache();
  });

  it('rechaza una zona gris en o por encima de la aprobacion automatica (400) sin tocar la base', async () => {
    enqueue('parametros_calibracion', { data: [], error: null }); // vigentes: 70 / 85

    await expect(setParametro('UMBRAL_ZONA_GRIS', 85, USER)).rejects.toMatchObject({
      statusCode: 400,
      errorCode: 'PARAMETRO_INVALIDO',
    });
    expect(opsDe('parametros_calibracion_historial', 'insert')).toHaveLength(0);
    expect(opsDe('parametros_calibracion', 'upsert')).toHaveLength(0);
  });

  it('compara contra el valor guardado de la pareja: bajar la aprobacion en cascada por debajo del rechazo', async () => {
    enqueue('parametros_calibracion', { data: [{ clave: 'UMBRAL_CASCADA_RECHAZO', valor: 60 }], error: null });

    await expect(setParametro('UMBRAL_CASCADA_APROBACION', 55, USER)).rejects.toMatchObject({
      statusCode: 400,
      errorCode: 'PARAMETRO_INVALIDO',
    });
  });

  it('validarCoherencia solo mira la pareja de la clave que cambia', () => {
    const cruzada = { ...CALIBRACION_DEFAULT, UMBRAL_ZONA_GRIS: 90 };
    expect(validarCoherencia(cruzada, 'UMBRAL_ZONA_GRIS')).toMatch(/zona gris/);
    expect(validarCoherencia(cruzada, 'UMBRAL_APROBACION_AUTOMATICA')).toMatch(/zona gris/);
    expect(validarCoherencia(cruzada, 'DIAS_EXPIRACION_ESTUDIO')).toBeNull();
    expect(validarCoherencia(CALIBRACION_DEFAULT, 'UMBRAL_CASCADA_RECHAZO')).toBeNull();
  });
});
