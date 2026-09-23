import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Panel de huérfanos: la consulta de perfiles va por lote (PostgREST corta en
// 1000 filas y las cuentas reales salían como huérfanas) y el borrado desde
// ese panel no toca una cuenta con perfil. Alta desde el panel: una
// inmobiliaria nace con su organización (si no, no podía operar).
// ============================================================

const { ins, ops, rpc, auth, mockEnsureOrg } = vi.hoisted(() => ({
  ins: [] as unknown[][],
  ops: [] as unknown[][],
  rpc: vi.fn(),
  auth: {
    listUsers: vi.fn(),
    getUserById: vi.fn(),
    deleteUser: vi.fn(async () => ({ error: null })),
    createUser: vi.fn(),
  },
  mockEnsureOrg: vi.fn(async () => 'org-1'),
}));

vi.mock('@/lib/supabase', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'update', 'eq', 'is']) chain[m] = (...a: unknown[]) => (ops.push([m, ...a]), chain);
  // Solo existe perfil para 'real-1'.
  chain.in = async (_c: string, ids: string[]) => {
    ins.push(ids);
    return { data: ids.filter((id) => id === 'real-1').map((id) => ({ id })), error: null };
  };
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve);
  return {
    supabase: { from: (t: string) => (ops.push(['from', t]), chain), rpc: (...a: unknown[]) => rpc(...a) },
    supabaseAuth: { auth: { admin: auth } },
  };
});
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/email', () => ({ sendWelcomeEmail: vi.fn() }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/middleware/auth', () => ({ invalidateAuthCache: vi.fn() }));
vi.mock('@/lib/tenantScope', () => ({
  ensureOrgConOwner: mockEnsureOrg,
  resolveInmobiliariaIdForPerfil: vi.fn(async () => null),
  resolveMembershipInmobiliariaIds: vi.fn(async () => []),
}));

import { listOrphanAuthUsers, deleteUser, createUser, updateUser } from '../users.service';

beforeEach(() => {
  ins.length = 0;
  ops.length = 0;
  vi.clearAllMocks();
});

describe('huérfanos', () => {
  it('pregunta por perfil lote a lote y solo marca a quien no lo tiene', async () => {
    auth.listUsers.mockResolvedValueOnce({
      data: { users: [{ id: 'real-1', created_at: 'x' }, { id: 'roto-1', created_at: 'x' }] },
      error: null,
    });
    const orphans = await listOrphanAuthUsers();
    expect(ins).toEqual([['real-1', 'roto-1']]);
    expect(orphans.map((o) => o.id)).toEqual(['roto-1']);
  });

  it('desde el panel de huérfanos no borra una cuenta con perfil', async () => {
    rpc.mockResolvedValueOnce({ data: [{ id: 'real-1', email: 'a@b.co' }], error: null });
    await expect(deleteUser('real-1', 'admin', { force: true, soloHuerfano: true }))
      .rejects.toMatchObject({ statusCode: 409, errorCode: 'USER_NOT_ORPHAN' });
    expect(auth.deleteUser).not.toHaveBeenCalled();
  });
});

describe('alta desde el panel', () => {
  it('una inmobiliaria nace con su organización', async () => {
    rpc
      .mockReturnValueOnce({ single: async () => ({ data: null }) }) // find_user_by_email
      .mockResolvedValueOnce({ data: [{ id: 'nuevo' }], error: null }); // get_user_with_email
    auth.createUser.mockResolvedValueOnce({ data: { user: { id: 'nuevo' } }, error: null });
    await createUser({ email: 'i@x.co', nombre: 'Casa', apellido: 'Sur', rol: 'inmobiliaria' } as never, 'admin');
    expect(mockEnsureOrg).toHaveBeenCalledWith('nuevo', 'Casa Sur');
  });

  it('un propietario que pasa a inmobiliaria se lleva sus fichas sin organización', async () => {
    const antes = { data: [{ id: 'p1', rol: 'propietario', nombre: 'Ana', apellido: 'Ruiz' }], error: null };
    rpc.mockResolvedValueOnce(antes).mockResolvedValueOnce(antes); // get_user_with_email antes y después
    await updateUser('p1', { rol: 'inmobiliaria' } as never, 'admin');
    expect(mockEnsureOrg).toHaveBeenCalledWith('p1', 'Ana Ruiz');
    const i = ops.findIndex((o) => o[0] === 'from' && o[1] === 'solicitantes');
    expect(ops.slice(i, i + 4)).toEqual([
      ['from', 'solicitantes'],
      ['update', { inmobiliaria_id: 'org-1' }],
      ['eq', 'creado_por', 'p1'],
      ['is', 'inmobiliaria_id', null],
    ]);
  });
});
