import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Barrido de estudios colgados en 'en_proceso' (reinicio de la API a mitad de
// la consulta al buró, o fallo al registrar el resultado). Mismo mock de
// Supabase que el resto del modulo: builder encadenable + colas POR TABLA y
// `ops` para afirmar lo que se escribio.
// ============================================================

const { ops, queues, enqueue, mockFrom } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const METODOS = ['select', 'update', 'insert', 'eq', 'lt', 'in', 'order', 'limit'];
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of METODOS) {
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    }
    chain.maybeSingle = async () => next(table);
    chain.single = async () => next(table);
    chain.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  return {
    ops,
    queues,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    mockFrom: vi.fn((table: string) => chainFor(table)),
  };
});

vi.mock('@/config', () => ({ env: new Proxy({}, { get: () => false }) }));
vi.mock('@/config/env', () => ({ env: new Proxy({}, { get: () => false }) }));
vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t), rpc: vi.fn(), storage: { from: vi.fn() } } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({
  logAudit: vi.fn(),
  AUDIT_ACTIONS: new Proxy({}, { get: (_t, k) => String(k) }),
  AUDIT_ENTITIES: new Proxy({}, { get: (_t, k) => String(k) }),
}));
vi.mock('@/lib/email', () => ({ sendEstudioFormEmail: vi.fn() }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({
  notificarUsuario: vi.fn(async () => undefined),
  findPerfilIdByEmail: vi.fn(),
  notificarResponsableExpediente: vi.fn(async () => undefined),
}));
vi.mock('@/modules/whatsapp', () => ({ enviarTemplate: vi.fn() }));

import { barrerEstudiosEnProcesoColgados } from '../estudios.service';
import { notificarUsuario, notificarResponsableExpediente } from '@/modules/notificaciones/notificaciones.service';

const colgado = (respuesta: unknown, observaciones: string | null = null) => ({
  id: 'est-1',
  expediente_id: 'exp-1',
  updated_at: '2026-09-23T10:00:00+00:00',
  observaciones,
  respuesta_proveedor: respuesta,
});
const updates = () => ops.filter((o) => o.table === 'estudios' && o.method === 'update').map((o) => o.args[0]);
const eqs = () => ops.filter((o) => o.table === 'estudios' && o.method === 'eq').map((o) => o.args);

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
});

describe('barrerEstudiosEnProcesoColgados', () => {
  it('solo mira los en_proceso sin movimiento hace mas de 10 minutos', async () => {
    enqueue('estudios', { data: [], error: null });
    await barrerEstudiosEnProcesoColgados();
    expect(eqs()).toContainEqual(['estado', 'en_proceso']);
    const lt = ops.find((o) => o.method === 'lt');
    expect(lt?.args[0]).toBe('updated_at');
    const minutos = (Date.now() - new Date(lt?.args[1] as string).getTime()) / 60000;
    expect(minutos).toBeGreaterThanOrEqual(9.9);
    expect(updates()).toEqual([]);
  });

  it('sin respuesta del buro: pasa a fallido (CAS sobre en_proceso) y avisa como cualquier fallido', async () => {
    enqueue('estudios', { data: [colgado(null)], error: null }, { data: [{ id: 'est-1' }], error: null });
    enqueue('perfiles', { data: [{ id: 'admin-1' }], error: null });

    await barrerEstudiosEnProcesoColgados();

    expect(updates()).toEqual([
      { estado: 'fallido', observaciones: expect.stringMatching(/interrumpi.*No es un rechazo/) },
    ]);
    expect(eqs()).toContainEqual(['estado', 'en_proceso']);
    expect(ops.some((o) => o.table === 'eventos_timeline' && o.method === 'insert')).toBe(true);
    expect(notificarResponsableExpediente).toHaveBeenCalled();
    expect(notificarUsuario).toHaveBeenCalledWith(expect.objectContaining({ userId: 'admin-1' }));
  });

  it('con respuesta guardada: sigue en en_proceso (no se vuelve a facturar) y avisa solo a los internos', async () => {
    enqueue('estudios', { data: [colgado({ score: 700 }, 'Fallo viejo')], error: null }, { data: [{ id: 'est-1' }], error: null });
    enqueue('perfiles', { data: [{ id: 'admin-1' }], error: null });

    await barrerEstudiosEnProcesoColgados();

    const [cambio] = updates() as Array<Record<string, unknown>>;
    expect(cambio).not.toHaveProperty('estado');
    expect(cambio.observaciones).toMatch(/Registrar resultado/);
    // CAS tambien por updated_at: dos instancias no avisan dos veces.
    expect(eqs()).toContainEqual(['updated_at', '2026-09-23T10:00:00+00:00']);
    expect(ops.some((o) => o.table === 'eventos_timeline')).toBe(false);
    expect(notificarResponsableExpediente).not.toHaveBeenCalled();
    expect(notificarUsuario).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin-1', titulo: expect.stringMatching(/sin registrar/) }),
    );
  });

  it('con respuesta y ya avisado: no escribe ni avisa otra vez', async () => {
    enqueue('estudios', { data: [colgado({ score: 700 }, 'El buró respondió, pero el resultado no se registró solo. Un analista de Cofianza lo registra con «Registrar resultado».')], error: null });
    await barrerEstudiosEnProcesoColgados();
    expect(updates()).toEqual([]);
    expect(notificarUsuario).not.toHaveBeenCalled();
  });

  it('si el CAS no toma la fila (el estudio termino entre medio) no avisa', async () => {
    enqueue('estudios', { data: [colgado(null)], error: null }, { data: [], error: null });
    await barrerEstudiosEnProcesoColgados();
    expect(notificarUsuario).not.toHaveBeenCalled();
    expect(notificarResponsableExpediente).not.toHaveBeenCalled();
  });
});
