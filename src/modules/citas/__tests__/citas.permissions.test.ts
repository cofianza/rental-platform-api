import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Permisos de citas. Mismo mock de Supabase con colas por tabla que moras.
// ============================================================

const { mockFrom, enqueue, resetQueues, mockAllowedExp } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'or', 'order']) chain[m] = () => chain;
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
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t) } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
// La cartera por fila (puedeVerFilaExpediente) es la real: lee la membresía de la cola.
vi.mock('@/lib/tenantScope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tenantScope')>()),
  resolveAllowedExpedienteIds: (...a: unknown[]) => mockAllowedExp(...a),
}));

import { assertCitaPermission, resolveAccessibleExpedienteIds } from '../citas.permissions';
import { invalidateMembresiasCache } from '@/lib/tenantScope';

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
  invalidateMembresiasCache();
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

describe('resolveAccessibleExpedienteIds — inmobiliaria', () => {
  it('incluye los estudios asignados al miembro restringido (el alcance de tenantScope)', async () => {
    mockAllowedExp.mockResolvedValue(['exp-de-su-inmueble', 'exp-asignado']);
    await expect(resolveAccessibleExpedienteIds('miembro', 'inmobiliaria')).resolves.toEqual([
      'exp-de-su-inmueble',
      'exp-asignado',
    ]);
    expect(mockAllowedExp).toHaveBeenCalledWith('miembro', 'inmobiliaria');
  });
});

describe('assertCitaPermission — inmobiliaria: la misma cartera que la lista de citas', () => {
  const miembro = (rol_miembro: string, miembros_ven_todo: boolean) =>
    enqueue('inmobiliaria_miembros', {
      data: [{ inmobiliaria_id: 'org1', rol_miembro, inmobiliarias: { nombre: 'Org', miembros_ven_todo } }],
      error: null,
    });
  const estudioDeCompanero = (asignadoA: string | null) => ({
    ...expedienteDelArrendatario,
    miembro_responsable_id: asignadoA,
    inmuebles: { propietario_id: 'companero', inmobiliaria_id: 'org1', miembro_responsable_id: null },
  });
  const pedir = () =>
    assertCitaPermission({ userId: 'asesor', userRol: 'inmobiliaria', expedienteId: 'exp1', action: 'confirmar' });

  it('el miembro restringido no toca las visitas del estudio de un compañero', async () => {
    enqueue('expedientes', { data: estudioDeCompanero(null), error: null });
    miembro('miembro', false);
    await expect(pedir()).rejects.toMatchObject({ statusCode: 403, errorCode: 'CITA_FORBIDDEN' });
  });

  it('sí las del estudio que le asignaron', async () => {
    enqueue('expedientes', { data: estudioDeCompanero('asesor'), error: null });
    miembro('miembro', false);
    await expect(pedir()).resolves.toMatchObject({ expedienteId: 'exp1' });
  });

  it('el titular y el miembro que ve todo, las de toda la organización', async () => {
    enqueue('expedientes', { data: estudioDeCompanero(null), error: null });
    miembro('owner', false);
    await expect(pedir()).resolves.toMatchObject({ expedienteId: 'exp1' });
    invalidateMembresiasCache();
    enqueue('expedientes', { data: estudioDeCompanero(null), error: null });
    miembro('miembro', true);
    await expect(pedir()).resolves.toMatchObject({ expedienteId: 'exp1' });
  });

  it('nunca las de otra organización', async () => {
    enqueue('expedientes', {
      data: { ...estudioDeCompanero(null), inmuebles: { propietario_id: 'otra', inmobiliaria_id: 'org2', miembro_responsable_id: null } },
      error: null,
    });
    miembro('owner', false);
    await expect(pedir()).rejects.toMatchObject({ statusCode: 403 });
  });
});
