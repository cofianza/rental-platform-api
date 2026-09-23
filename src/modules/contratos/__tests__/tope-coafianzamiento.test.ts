import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Adenda 1 contratos §2.4: canon por encima del tope → escalamiento a la
// Gerencia General, UNA vez por estudio. Primero la marca en la línea de
// tiempo (sin marca no hay aviso); después el aviso a los administradores
// activos (app y correo); si el aviso no se guarda, se retira la marca.
// Mock de Supabase con colas por tabla y por forma de leer: `tabla.then` (el
// await directo, p. ej. la consulta de la marca) y `tabla.single` (el insert
// de la marca), para que los dos intentos simultáneos consuman lo que les toca.
// ============================================================

const { queues, ops, enqueue, chainFor, mockCorreo } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (t: string, forma: string): Res =>
    queues.get(`${t}.${forma}`)?.shift() ?? queues.get(t)?.shift() ?? { data: null, error: null };
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'delete', 'eq', 'limit'])
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    chain.maybeSingle = async () => next(table, 'single');
    chain.single = async () => next(table, 'single');
    chain.then = (ok: (v: Res) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(next(table, 'then')).then(ok, ko);
    return chain;
  };
  return {
    queues,
    ops,
    enqueue: (t: string, ...r: Res[]) => queues.set(t, [...(queues.get(t) ?? []), ...r]),
    chainFor,
    mockCorreo: vi.fn(async (..._a: unknown[]) => undefined),
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => chainFor(t) } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/config/env', () => ({ env: { CANON_MAXIMO_SIN_COAFIANZAMIENTO_COP: 3_000_000 } }));
vi.mock('@/lib/calibracion', () => ({ getCalibracion: vi.fn() }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({ enviarCorreoNotificacion: mockCorreo }));

import { escalarTopeCanon, topeYaEscalado } from '../tope-coafianzamiento';

const de = (table: string, method: string) => ops.filter((o) => o.table === table && o.method === method);
const pos = (table: string, method: string) => ops.findIndex((o) => o.table === table && o.method === method);
/** Un intento completo: sin marca, la marca se escribe, el estudio y dos administradores activos. */
const intento = (marcaId = 'ev1') => {
  enqueue('eventos_timeline.then', { data: [], error: null });
  enqueue('eventos_timeline.single', { data: { id: marcaId }, error: null });
  enqueue('expedientes', { data: { numero: 'EXP-2026-0100' }, error: null });
  enqueue('perfiles', { data: [{ id: 'admin-1' }, { id: 'admin-2' }], error: null });
};

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
});

describe('escalarTopeCanon', () => {
  it('la primera vez: marca en la línea de tiempo, DESPUÉS el aviso (app y correo) a los administradores; responde true', async () => {
    intento();
    expect(await escalarTopeCanon('exp-1', 3_100_000, 3_000_000, 'contrato')).toBe(true);

    expect(de('eventos_timeline', 'eq').map((o) => o.args)).toContainEqual(['metadata->>escalamiento', 'tope_canon']);
    expect(de('eventos_timeline', 'insert')[0].args[0]).toMatchObject({
      expediente_id: 'exp-1',
      tipo: 'contrato',
      usuario_id: null,
      metadata: { escalamiento: 'tope_canon', canon_cop: 3_100_000, tope_cop: 3_000_000, ambito: 'contrato' },
    });
    expect(pos('eventos_timeline', 'insert')).toBeLessThan(pos('notificaciones', 'insert'));
    expect(de('perfiles', 'eq').map((o) => o.args)).toEqual([
      ['rol', 'administrador'],
      ['estado', 'activo'],
    ]);
    const avisos = de('notificaciones', 'insert')[0].args[0] as Array<Record<string, unknown>>;
    expect(avisos.map((a) => a.user_id)).toEqual(['admin-1', 'admin-2']);
    expect(avisos[0]).toMatchObject({
      tipo: 'contrato.tope_canon',
      link: '/expedientes/exp-1',
      payload: { expediente_id: 'exp-1', canon_cop: 3_100_000, tope_cop: 3_000_000, ambito: 'contrato' },
    });
    expect(String(avisos[0].mensaje)).toContain('El contrato del estudio EXP-2026-0100 pacta un canon de $3.100.000');
    // Correo, como los demás avisos internos.
    expect(mockCorreo.mock.calls.map((c) => (c[0] as { userId: string }).userId)).toEqual(['admin-1', 'admin-2']);
    expect(mockCorreo.mock.calls[0][0]).toMatchObject({ tipo: 'contrato.tope_canon', link: '/expedientes/exp-1' });
    expect(de('eventos_timeline', 'delete')).toEqual([]);
  });

  it('al habilitar o pagar la evaluación el aviso lo dice', async () => {
    intento();
    await escalarTopeCanon('exp-1', 3_100_000, 3_000_000, 'estudio');
    const [aviso] = de('notificaciones', 'insert')[0].args[0] as Array<{ mensaje: string }>;
    expect(aviso.mensaje).toContain('La evaluación del estudio EXP-2026-0100 es sobre un inmueble con canon de $3.100.000');
  });

  it('ya escalado (hay marca): true sin escribir ni avisar', async () => {
    enqueue('eventos_timeline.then', { data: [{ id: 'ev-1' }], error: null });
    expect(await escalarTopeCanon('exp-1', 3_100_000, 3_000_000, 'contrato')).toBe(true);
    expect(de('eventos_timeline', 'insert')).toEqual([]);
    expect(de('notificaciones', 'insert')).toEqual([]);
    expect(mockCorreo).not.toHaveBeenCalled();
  });

  it('dos intentos a la vez del mismo estudio comparten el escalamiento: un solo aviso', async () => {
    // Respuestas para DOS escalamientos completos: sin el candado, los dos avisarían.
    intento('ev1');
    intento('ev2');
    const r = await Promise.all([
      escalarTopeCanon('exp-1', 3_100_000, 3_000_000, 'contrato'),
      escalarTopeCanon('exp-1', 3_100_000, 3_000_000, 'contrato'),
    ]);
    expect(r).toEqual([true, true]);
    expect(de('eventos_timeline', 'insert')).toHaveLength(1);
    expect(de('notificaciones', 'insert')).toHaveLength(1);
  });

  it('si la marca no se puede escribir, no avisa y responde false', async () => {
    enqueue('eventos_timeline.then', { data: [], error: null });
    enqueue('eventos_timeline.single', { data: null, error: { message: 'timeout' } });
    expect(await escalarTopeCanon('exp-1', 3_100_000, 3_000_000, 'contrato')).toBe(false);
    expect(ops.some((o) => o.table === 'notificaciones')).toBe(false);
    expect(mockCorreo).not.toHaveBeenCalled();
  });

  it('si el aviso no se guarda, retira la marca (el siguiente intento lo repite) y responde false', async () => {
    intento('ev9');
    enqueue('notificaciones', { data: null, error: { message: 'timeout' } });
    expect(await escalarTopeCanon('exp-1', 3_100_000, 3_000_000, 'contrato')).toBe(false);
    expect(de('eventos_timeline', 'delete')).toHaveLength(1);
    expect(ops.slice(pos('eventos_timeline', 'delete')).find((o) => o.method === 'eq')?.args).toEqual(['id', 'ev9']);
    expect(mockCorreo).not.toHaveBeenCalled();
  });

  it('sin administradores activos tampoco queda la marca', async () => {
    enqueue('eventos_timeline.then', { data: [], error: null });
    enqueue('eventos_timeline.single', { data: { id: 'ev1' }, error: null });
    enqueue('perfiles', { data: [], error: null });
    expect(await escalarTopeCanon('exp-1', 3_100_000, 3_000_000, 'contrato')).toBe(false);
    expect(de('eventos_timeline', 'delete')).toHaveLength(1);
  });

  it('sin poder verificar la marca no escribe ni avisa (evita duplicar)', async () => {
    enqueue('eventos_timeline.then', { data: null, error: { message: 'timeout' } });
    expect(await escalarTopeCanon('exp-1', 3_100_000, 3_000_000, 'contrato')).toBe(false);
    expect(de('eventos_timeline', 'insert')).toEqual([]);
    expect(ops.some((o) => o.table === 'notificaciones')).toBe(false);
  });
});

describe('topeYaEscalado', () => {
  it('lee la marca sin escribir; ante un error, false', async () => {
    enqueue('eventos_timeline.then', { data: [{ id: 'ev-1' }], error: null }, { data: [], error: null }, { data: null, error: { message: 'x' } });
    expect(await topeYaEscalado('exp-1')).toBe(true);
    expect(await topeYaEscalado('exp-1')).toBe(false);
    expect(await topeYaEscalado('exp-1')).toBe(false);
    expect(ops.filter((o) => ['insert', 'delete'].includes(o.method))).toEqual([]);
  });
});
