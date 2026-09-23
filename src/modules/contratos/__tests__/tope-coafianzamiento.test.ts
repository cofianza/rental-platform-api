import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Adenda 1 contratos §2.4: canon por encima del tope → aviso a los
// administradores de Cofianza para evaluar coafianzamiento, UNA vez por
// estudio (la marca es un evento del timeline). Mock de Supabase con colas
// por tabla; `ops` registra lo que se consultó y escribió.
// ============================================================

const { queues, ops, enqueue, chainFor } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (t: string): Res => queues.get(t)?.shift() ?? { data: null, error: null };
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'eq', 'limit'])
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    chain.maybeSingle = async () => next(table);
    chain.then = (ok: (v: Res) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(next(table)).then(ok, ko);
    return chain;
  };
  return {
    queues,
    ops,
    enqueue: (t: string, ...r: Res[]) => queues.set(t, [...(queues.get(t) ?? []), ...r]),
    chainFor,
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => chainFor(t) } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/config/env', () => ({ env: { CANON_MAXIMO_SIN_COAFIANZAMIENTO_COP: 3_000_000 } }));
vi.mock('@/lib/calibracion', () => ({ getCalibracion: vi.fn() }));

import { escalarTopeCanon } from '../tope-coafianzamiento';

const de = (table: string, method: string) => ops.filter((o) => o.table === table && o.method === method);
/** Primera vez: sin marca en el timeline, el estudio y dos administradores activos. */
const primeraVez = () => {
  enqueue('eventos_timeline', { data: [], error: null });
  enqueue('expedientes', { data: { numero: 'EXP-2026-0100' }, error: null });
  enqueue('perfiles', { data: [{ id: 'admin-1' }, { id: 'admin-2' }], error: null });
};

beforeEach(() => {
  queues.clear();
  ops.length = 0;
});

describe('escalarTopeCanon', () => {
  it('la primera vez avisa a los administradores activos con enlace al estudio y deja la marca en el timeline', async () => {
    primeraVez();
    await escalarTopeCanon('exp-1', 3_100_000, 3_000_000);

    expect(de('eventos_timeline', 'eq').map((o) => o.args)).toContainEqual(['metadata->>escalamiento', 'tope_canon']);
    expect(de('perfiles', 'eq').map((o) => o.args)).toEqual([
      ['rol', 'administrador'],
      ['estado', 'activo'],
    ]);
    const avisos = de('notificaciones', 'insert')[0].args[0] as Array<Record<string, unknown>>;
    expect(avisos.map((a) => a.user_id)).toEqual(['admin-1', 'admin-2']);
    expect(avisos[0]).toMatchObject({
      tipo: 'contrato.tope_canon',
      link: '/expedientes/exp-1',
      payload: { expediente_id: 'exp-1', canon_cop: 3_100_000, tope_cop: 3_000_000 },
    });
    expect(String(avisos[0].mensaje)).toContain('$3.100.000');
    expect(String(avisos[0].mensaje)).toContain('coafianzamiento');
    expect(de('eventos_timeline', 'insert')[0].args[0]).toMatchObject({
      expediente_id: 'exp-1',
      tipo: 'contrato',
      usuario_id: null,
      metadata: { escalamiento: 'tope_canon', canon_cop: 3_100_000, tope_cop: 3_000_000 },
    });
  });

  it('ya escalado (hay marca): no avisa ni escribe de nuevo', async () => {
    enqueue('eventos_timeline', { data: [{ id: 'ev-1' }], error: null });
    await escalarTopeCanon('exp-1', 3_100_000, 3_000_000);
    expect(de('notificaciones', 'insert')).toEqual([]);
    expect(de('eventos_timeline', 'insert')).toEqual([]);
  });

  it('dos cargas a la vez del mismo estudio avisan una sola vez', async () => {
    primeraVez();
    await Promise.all([escalarTopeCanon('exp-1', 3_100_000, 3_000_000), escalarTopeCanon('exp-1', 3_100_000, 3_000_000)]);
    expect(de('notificaciones', 'insert')).toHaveLength(1);
  });

  it('si el aviso no se pudo guardar, no deja la marca (la próxima carga reintenta) y no lanza', async () => {
    primeraVez();
    enqueue('notificaciones', { data: null, error: { message: 'timeout' } });
    await expect(escalarTopeCanon('exp-1', 3_100_000, 3_000_000)).resolves.toBeUndefined();
    expect(de('eventos_timeline', 'insert')).toEqual([]);
  });

  it('sin poder verificar la marca no avisa (evita duplicar)', async () => {
    enqueue('eventos_timeline', { data: null, error: { message: 'timeout' } });
    await escalarTopeCanon('exp-1', 3_100_000, 3_000_000);
    expect(ops.some((o) => o.table === 'notificaciones')).toBe(false);
  });
});
