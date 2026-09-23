import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// /usuarios frente a la organización: borrar al titular principal de una
// agencia con equipo se llevaba la inmobiliaria (owner_perfil_id ON DELETE
// CASCADE) y cambiarle el rol a un miembro lo sacaba sin los guardas del
// equipo. Tampoco nadie se cambia su propio rol. Mock con colas por tabla.
// ============================================================

const { ops, enqueue, queues, rpc, auth, mockMembresias, chainFor } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null, count: null };
  };
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'update', 'eq', 'neq', 'is', 'in']) {
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    }
    chain.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  const enqueue = (table: string, ...items: Res[]) => {
    queues.set(table, [...(queues.get(table) ?? []), ...items]);
  };
  return {
    ops,
    enqueue,
    queues,
    rpc: vi.fn(),
    auth: { deleteUser: vi.fn(async () => ({ error: null })) },
    mockMembresias: vi.fn(async (_id: string): Promise<string[]> => []),
    chainFor,
  };
});

vi.mock('@/lib/supabase', () => ({
  supabase: { from: (t: string) => chainFor(t), rpc: (...a: unknown[]) => rpc(...a) },
  supabaseAuth: { auth: { admin: auth } },
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/email', () => ({ sendWelcomeEmail: vi.fn() }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/middleware/auth', () => ({ invalidateAuthCache: vi.fn() }));
vi.mock('@/lib/tenantScope', () => ({
  ensureOrgConOwner: vi.fn(),
  resolveInmobiliariaIdForPerfil: vi.fn(async () => 'org-1'),
  resolveMembershipInmobiliariaIds: (id: string) => mockMembresias(id),
}));

import { deleteUser, updateUser } from '../users.service';

const perfil = (rol: string) => ({ data: [{ id: 'u1', email: 'u@x.co', rol, nombre: 'Ana', apellido: 'Ruiz' }], error: null });
const escribioPerfil = () => ops.some((o) => o.table === 'perfiles' && o.method === 'update');

beforeEach(() => {
  ops.length = 0;
  queues.clear();
  rpc.mockReset();
  auth.deleteUser.mockClear();
  mockMembresias.mockReset();
  mockMembresias.mockResolvedValue([]);
});

describe('borrar al titular principal', () => {
  it('con equipo no se borra, ni con force', async () => {
    rpc.mockResolvedValueOnce(perfil('inmobiliaria'));
    enqueue('inmobiliarias', { data: [{ id: 'org-1' }], error: null });
    enqueue('inmobiliaria_miembros', { count: 2, error: null });
    await expect(deleteUser('u1', 'admin', { force: true }))
      .rejects.toMatchObject({ statusCode: 409, errorCode: 'USER_IS_ORG_OWNER' });
    expect(auth.deleteUser).not.toHaveBeenCalled();
    expect(ops).toContainEqual({ table: 'inmobiliaria_miembros', method: 'neq', args: ['perfil_id', 'u1'] });
  });

  it('una agencia de una sola persona sí se puede borrar', async () => {
    rpc.mockResolvedValueOnce(perfil('inmobiliaria'));
    enqueue('inmobiliarias', { data: [{ id: 'org-1' }], error: null });
    enqueue('inmobiliaria_miembros', { count: 0, error: null });
    await deleteUser('u1', 'admin');
    expect(auth.deleteUser).toHaveBeenCalledWith('u1');
  });
});

describe('cambiar el rol desde /usuarios', () => {
  it('a un miembro de una agencia con equipo: no, y no toca el perfil', async () => {
    rpc.mockResolvedValueOnce(perfil('inmobiliaria'));
    mockMembresias.mockResolvedValue(['org-1']);
    enqueue('inmobiliaria_miembros', { count: 1, error: null });
    await expect(updateUser('u1', { rol: 'propietario' } as never, 'admin'))
      .rejects.toMatchObject({ statusCode: 409, errorCode: 'MIEMBRO_CON_EQUIPO' });
    expect(escribioPerfil()).toBe(false);
  });

  it('su propio rol: no', async () => {
    rpc.mockResolvedValueOnce(perfil('administrador'));
    await expect(updateUser('u1', { rol: 'propietario' } as never, 'u1'))
      .rejects.toMatchObject({ statusCode: 400, errorCode: 'SELF_ROLE_CHANGE' });
    expect(escribioPerfil()).toBe(false);
  });

  it('editar su nombre reenviando el mismo rol sí pasa', async () => {
    rpc.mockResolvedValue(perfil('administrador'));
    await updateUser('u1', { nombre: 'Ana', rol: 'administrador' } as never, 'u1');
    expect(escribioPerfil()).toBe(true);
  });
});
