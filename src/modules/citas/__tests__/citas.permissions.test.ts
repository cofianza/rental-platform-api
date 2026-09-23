import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Permisos de citas. Mismo mock de Supabase con colas por tabla que moras.
// ============================================================

const { mockFrom, enqueue, resetQueues, mockAllowedExp, mockAllowedInm } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'or']) chain[m] = () => chain;
    chain.single = async () => next(table);
    chain.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  return {
    mockFrom: vi.fn((table: string) => chainFor(table)),
    enqueue: (table: string, ...items: Res[]) => {
      queues.set(table, [...(queues.get(table) ?? []), ...items]);
    },
    resetQueues: () => queues.clear(),
    mockAllowedExp: vi.fn(),
    mockAllowedInm: vi.fn(),
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t) } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/tenantScope', () => ({
  resolveAllowedExpedienteIds: (...a: unknown[]) => mockAllowedExp(...a),
  resolveAllowedInmuebleIds: (...a: unknown[]) => mockAllowedInm(...a),
  resolveMembershipInmobiliariaIds: async () => [],
}));

import { assertCitaPermission } from '../citas.permissions';

const expedienteDelArrendatario = {
  id: 'exp1',
  numero: 'EXP-1',
  estado: 'en_revision',
  solicitante_id: 's1',
  inmueble_id: 'i1',
  inmuebles: { propietario_id: 'agencia', inmobiliaria_id: 'org1' },
  solicitantes: { creado_por: 'arrendatario' },
};

beforeEach(() => {
  resetQueues();
  mockAllowedExp.mockReset();
  mockAllowedInm.mockReset();
});

describe('assertCitaPermission — solicitante', () => {
  it.each(['cancelar', 'reprogramar'] as const)(
    'puede %s la visita que agendó la inmobiliaria en su estudio',
    async (action) => {
      enqueue('expedientes', { data: expedienteDelArrendatario, error: null });
      await expect(
        assertCitaPermission({ userId: 'arrendatario', userRol: 'solicitante', expedienteId: 'exp1', action }),
      ).resolves.toMatchObject({ expedienteId: 'exp1' });
    },
  );

  it('sigue sin poder confirmar ni tocar el estudio de otro', async () => {
    enqueue('expedientes', { data: expedienteDelArrendatario, error: null });
    await expect(
      assertCitaPermission({ userId: 'arrendatario', userRol: 'solicitante', expedienteId: 'exp1', action: 'confirmar' }),
    ).rejects.toMatchObject({ statusCode: 403 });
    enqueue('expedientes', { data: expedienteDelArrendatario, error: null });
    await expect(
      assertCitaPermission({ userId: 'otro', userRol: 'solicitante', expedienteId: 'exp1', action: 'cancelar' }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
