import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// /usuarios frente a la organización: borrar al titular principal de una
// agencia con equipo se llevaba la inmobiliaria (owner_perfil_id ON DELETE
// CASCADE) y cambiarle el rol a un miembro lo sacaba sin los guardas del
// equipo. Tampoco nadie se cambia su propio rol. Y restablecer la contraseña
// cierra las sesiones abiertas. Mock con colas por tabla. Y las cuentas de la
// Gerencia General (Adenda 1 del módulo de contratos, respuesta 17) solo las
// gestiona la Gerencia.
// ============================================================

const { ops, enqueue, queues, rpc, auth, mockMembresias, mockCerrar, chainFor, mockEnv } = vi.hoisted(() => {
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
    auth: {
      deleteUser: vi.fn(async () => ({ error: null })),
      updateUserById: vi.fn(async () => ({ error: null })),
    },
    mockCerrar: vi.fn(async (_id: string) => {}),
    mockMembresias: vi.fn(async (_id: string): Promise<string[]> => []),
    chainFor,
    mockEnv: { GERENCIA_GENERAL_EMAILS: [] as string[] },
  };
});

vi.mock('@/config', () => ({ env: mockEnv }));

vi.mock('@/lib/supabase', () => ({
  supabase: { from: (t: string) => chainFor(t), rpc: (...a: unknown[]) => rpc(...a) },
  supabaseAuth: { auth: { admin: auth } },
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/email', () => ({ sendWelcomeEmail: vi.fn() }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/middleware/auth', () => ({
  invalidateAuthCache: vi.fn(),
  cerrarSesionesDe: (id: string) => mockCerrar(id),
}));
vi.mock('@/lib/tenantScope', () => ({
  ensureOrgConOwner: vi.fn(),
  resolveInmobiliariaIdForPerfil: vi.fn(async () => 'org-1'),
  resolveMembershipInmobiliariaIds: (id: string) => mockMembresias(id),
}));

import { createUser, deactivateUser, deleteUser, updateUser, resetPasswordByAdmin } from '../users.service';

const ADMIN = { id: 'admin', email: 'admin@cofianza.co', rol: 'administrador' };
const perfil = (rol: string) => ({ data: [{ id: 'u1', email: 'u@x.co', rol, nombre: 'Ana', apellido: 'Ruiz' }], error: null });
const escribioPerfil = () => ops.some((o) => o.table === 'perfiles' && o.method === 'update');

beforeEach(() => {
  ops.length = 0;
  queues.clear();
  rpc.mockReset();
  auth.deleteUser.mockClear();
  mockCerrar.mockClear();
  mockMembresias.mockReset();
  mockMembresias.mockResolvedValue([]);
  auth.updateUserById.mockClear();
  mockEnv.GERENCIA_GENERAL_EMAILS = [];
});

describe('borrar al titular principal', () => {
  it('con equipo no se borra, ni con force', async () => {
    rpc.mockResolvedValueOnce(perfil('inmobiliaria'));
    enqueue('inmobiliarias', { data: [{ id: 'org-1' }], error: null });
    enqueue('inmobiliaria_miembros', { count: 2, error: null });
    await expect(deleteUser('u1', ADMIN, { force: true }))
      .rejects.toMatchObject({ statusCode: 409, errorCode: 'USER_IS_ORG_OWNER' });
    expect(auth.deleteUser).not.toHaveBeenCalled();
    expect(ops).toContainEqual({ table: 'inmobiliaria_miembros', method: 'neq', args: ['perfil_id', 'u1'] });
  });

  it('una agencia de una sola persona sí se puede borrar', async () => {
    rpc.mockResolvedValueOnce(perfil('inmobiliaria'));
    enqueue('inmobiliarias', { data: [{ id: 'org-1' }], error: null });
    enqueue('inmobiliaria_miembros', { count: 0, error: null });
    await deleteUser('u1', ADMIN);
    expect(auth.deleteUser).toHaveBeenCalledWith('u1');
  });
});

describe('cambiar el rol desde /usuarios', () => {
  it('a un miembro de una agencia con equipo: no, y no toca el perfil', async () => {
    rpc.mockResolvedValueOnce(perfil('inmobiliaria'));
    mockMembresias.mockResolvedValue(['org-1']);
    enqueue('inmobiliaria_miembros', { count: 1, error: null });
    await expect(updateUser('u1', { rol: 'propietario' } as never, ADMIN))
      .rejects.toMatchObject({ statusCode: 409, errorCode: 'MIEMBRO_CON_EQUIPO' });
    expect(escribioPerfil()).toBe(false);
  });

  it('su propio rol: no', async () => {
    rpc.mockResolvedValueOnce(perfil('administrador'));
    await expect(updateUser('u1', { rol: 'propietario' } as never, { ...ADMIN, id: 'u1' }))
      .rejects.toMatchObject({ statusCode: 400, errorCode: 'SELF_ROLE_CHANGE' });
    expect(escribioPerfil()).toBe(false);
  });

  it('editar su nombre reenviando el mismo rol sí pasa', async () => {
    rpc.mockResolvedValue(perfil('administrador'));
    await updateUser('u1', { nombre: 'Ana', rol: 'administrador' } as never, { ...ADMIN, id: 'u1' });
    expect(escribioPerfil()).toBe(true);
  });
});

describe('restablecer la contraseña desde el panel', () => {
  it('cierra todas las sesiones abiertas de la cuenta', async () => {
    rpc.mockResolvedValueOnce(perfil('propietario'));
    await resetPasswordByAdmin('u1', { password: 'Nueva1234' }, ADMIN);
    expect(auth.updateUserById).toHaveBeenCalledWith('u1', { password: 'Nueva1234' });
    expect(mockCerrar).toHaveBeenCalledWith('u1');
  });
});

describe('cuentas de la Gerencia General (Adenda 1 contratos, resp. 17)', () => {
  const MARIO = { data: [{ id: 'g1', email: 'Mario@Cofianza.co', rol: 'administrador', nombre: 'Mario', apellido: 'Vélez' }], error: null };
  const ANA_GERENCIA = { id: 'g2', email: 'ana@cofianza.co', rol: 'administrador' };
  const cuentaGerencia = { statusCode: 403, errorCode: 'CUENTA_GERENCIA_GENERAL' };
  beforeEach(() => {
    mockEnv.GERENCIA_GENERAL_EMAILS = ['mario@cofianza.co', 'ana@cofianza.co'];
  });

  it('otro administrador no le restablece la contraseña (403, sin tocar Auth ni las sesiones)', async () => {
    rpc.mockResolvedValueOnce(MARIO);
    await expect(resetPasswordByAdmin('g1', { password: 'Nueva1234' }, ADMIN)).rejects.toMatchObject(cuentaGerencia);
    expect(auth.updateUserById).not.toHaveBeenCalled();
    expect(mockCerrar).not.toHaveBeenCalled();
  });

  it('otro miembro de la Gerencia sí', async () => {
    rpc.mockResolvedValueOnce(MARIO);
    await resetPasswordByAdmin('g1', { password: 'Nueva1234' }, ANA_GERENCIA);
    expect(auth.updateUserById).toHaveBeenCalledWith('g1', { password: 'Nueva1234' });
  });

  it('no le cambia el rol, no la desactiva ni la borra; sí le corrige el nombre', async () => {
    rpc.mockResolvedValueOnce(MARIO);
    await expect(updateUser('g1', { rol: 'propietario' } as never, ADMIN)).rejects.toMatchObject(cuentaGerencia);
    expect(escribioPerfil()).toBe(false);

    rpc.mockResolvedValueOnce(MARIO);
    await expect(deactivateUser('g1', ADMIN)).rejects.toMatchObject(cuentaGerencia);
    expect(escribioPerfil()).toBe(false);
    expect(mockCerrar).not.toHaveBeenCalled();

    rpc.mockResolvedValueOnce(MARIO);
    await expect(deleteUser('g1', ADMIN, { force: true })).rejects.toMatchObject(cuentaGerencia);
    expect(auth.deleteUser).not.toHaveBeenCalled();

    rpc.mockResolvedValue(MARIO);
    await updateUser('g1', { nombre: 'Mario Andrés' } as never, ADMIN);
    expect(escribioPerfil()).toBe(true);
  });

  it('no crea una cuenta con un correo de la lista (sin distinguir mayúsculas), antes de tocar Auth', async () => {
    const alta = { email: 'MARIO@cofianza.co', nombre: 'Mario', apellido: 'Vélez', rol: 'administrador' } as never;
    await expect(createUser(alta, ADMIN)).rejects.toMatchObject(cuentaGerencia);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('con la lista vacía, todo como antes: cualquier administrador', async () => {
    mockEnv.GERENCIA_GENERAL_EMAILS = [];
    rpc.mockResolvedValueOnce(MARIO);
    await resetPasswordByAdmin('g1', { password: 'Nueva1234' }, ADMIN);
    expect(auth.updateUserById).toHaveBeenCalledWith('g1', { password: 'Nueva1234' });
  });
});
