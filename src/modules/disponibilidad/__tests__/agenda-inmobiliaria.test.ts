import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// P37: una sola agenda de visitas por inmobiliaria, la del titular principal.
// Los horarios de un inmueble registrado por un asesor salen de ella; los
// miembros la ven y solo los titulares la cambian.
// ============================================================

const { mockFrom, mockRpc, ops, enqueue, resetQueues, mockMembresia } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'upsert', 'delete', 'eq', 'not', 'order']) {
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
  return {
    mockFrom: vi.fn((table: string) => chainFor(table)),
    mockRpc: vi.fn(async (..._a: unknown[]) => ({ data: [], error: null }) as { data: unknown; error: unknown }),
    ops,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    resetQueues: () => queues.clear(),
    mockMembresia: vi.fn(),
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t), rpc: (...a: unknown[]) => mockRpc(...a) } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/tenantScope', () => ({
  getActiveMembership: (id: string) => mockMembresia(id),
  resolveOrgCanonicalPerfilId: async () => 'titular1',
  // El titular principal de la organización del inmueble.
  resolvePerfilCanonicoDeInmueble: async (inm: { propietario_id: string; inmobiliaria_id: string | null }) =>
    inm.inmobiliaria_id ? 'titular1' : inm.propietario_id,
}));

import {
  getSlotsPorInmueble,
  slotEstaDisponible,
  getMiDisponibilidad,
  guardarMiDisponibilidad,
} from '../disponibilidad.service';

const INPUT = { slot_duracion_minutos: 60 as const, antelacion_minima_horas: 24, max_citas_por_dia: 0, horarios: [], fechas_bloqueadas: [] };

beforeEach(() => {
  resetQueues();
  ops.length = 0;
  mockRpc.mockClear();
  mockMembresia.mockReset();
});

describe('agenda del inmueble', () => {
  it('un inmueble que registró un asesor usa la agenda del titular de la inmobiliaria', async () => {
    enqueue('inmuebles', { data: { propietario_id: 'asesor1', inmobiliaria_id: 'org1' }, error: null });
    await getSlotsPorInmueble('i1', '2026-10-01', '2026-10-14');
    expect(mockRpc).toHaveBeenCalledWith('fn_slots_disponibles', expect.objectContaining({ p_propietario_id: 'titular1' }));
    expect(ops).toContainEqual({ table: 'configuracion_disponibilidad', method: 'eq', args: ['propietario_id', 'titular1'] });

    mockRpc.mockResolvedValueOnce({ data: true, error: null });
    await slotEstaDisponible({ propietario_id: 'asesor1', inmobiliaria_id: 'org1' }, '2026-10-02T10:00:00-05:00');
    expect(mockRpc).toHaveBeenLastCalledWith('fn_slot_esta_disponible', expect.objectContaining({ p_propietario_id: 'titular1' }));
  });

  it('el propietario individual sigue con su propia agenda', async () => {
    enqueue('inmuebles', { data: { propietario_id: 'prop1', inmobiliaria_id: null }, error: null });
    await getSlotsPorInmueble('i2', '2026-10-01', '2026-10-14');
    expect(mockRpc).toHaveBeenCalledWith('fn_slots_disponibles', expect.objectContaining({ p_propietario_id: 'prop1' }));
  });
});

describe('/mi-disponibilidad', () => {
  it('el miembro ve la agenda del titular, sin poder editarla', async () => {
    mockMembresia.mockResolvedValue({ orgId: 'org1', rolMiembro: 'miembro', venTodo: true, nombreOrg: 'Norte' });
    const r = await getMiDisponibilidad('asesor1');
    expect(r).toMatchObject({ puede_editar: false, agenda_de_inmobiliaria: true });
    expect(ops).toContainEqual({ table: 'disponibilidad_propietario', method: 'eq', args: ['propietario_id', 'titular1'] });

    await expect(guardarMiDisponibilidad('asesor1', INPUT)).rejects.toMatchObject({ statusCode: 403 });
    expect(ops.filter((o) => ['upsert', 'delete', 'insert'].includes(o.method))).toEqual([]);
  });

  it('un co-titular la edita, y se guarda en la agenda de la inmobiliaria', async () => {
    mockMembresia.mockResolvedValue({ orgId: 'org1', rolMiembro: 'owner', venTodo: true, nombreOrg: 'Norte' });
    await guardarMiDisponibilidad('cotitular2', INPUT);
    const upsert = ops.find((o) => o.table === 'configuracion_disponibilidad' && o.method === 'upsert');
    expect(upsert?.args[0]).toMatchObject({ propietario_id: 'titular1' });
  });

  it('el propietario individual edita la suya', async () => {
    mockMembresia.mockResolvedValue(null);
    const r = await getMiDisponibilidad('prop1');
    expect(r).toMatchObject({ puede_editar: true, agenda_de_inmobiliaria: false });
    expect(ops).toContainEqual({ table: 'disponibilidad_propietario', method: 'eq', args: ['propietario_id', 'prop1'] });
  });
});
