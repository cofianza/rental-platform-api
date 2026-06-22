import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Mock supabase: builder encadenable + cola de resultados.
// Cada método de filtro devuelve el mismo builder; los terminales
// (maybeSingle/single) y el `await` directo del builder (count/update/delete)
// consumen el siguiente resultado de la cola, en orden de llamada.
// ============================================================

let queue: Array<Record<string, unknown>> = [];
const enqueue = (...items: Array<Record<string, unknown>>) => queue.push(...items);
const nextResult = (): Record<string, unknown> =>
  queue.length ? queue.shift()! : { data: null, error: null, count: null };

const chain: Record<string, unknown> = {};
const passthrough = ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'is', 'not', 'in', 'lt', 'gt', 'gte', 'lte', 'order', 'limit'];
passthrough.forEach((m) => {
  chain[m] = vi.fn(() => chain);
});
chain.maybeSingle = vi.fn(async () => nextResult());
chain.single = vi.fn(async () => nextResult());
// Hace al builder "thenable" para los queries que se await-ean sin maybeSingle.
chain.then = (resolve: (v: Record<string, unknown>) => unknown) => resolve(nextResult());

const mockFrom = vi.fn(() => chain);

vi.mock('@/lib/supabase', () => ({
  supabase: { from: (t: string) => mockFrom(t) },
  supabaseAuth: { auth: { admin: {} } },
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/config', () => ({ env: { FRONTEND_URL: 'http://localhost' } }));
vi.mock('@/lib/auditLog', () => ({
  logAudit: vi.fn(),
  AUDIT_ACTIONS: {
    MIEMBRO_INVITADO: 'miembro_invitado',
    MIEMBRO_REVOCADO: 'miembro_revocado',
    MIEMBRO_ACEPTO: 'miembro_acepto',
    MIEMBRO_ROL_CAMBIADO: 'miembro_rol_cambiado',
  },
  AUDIT_ENTITIES: { INMOBILIARIA_MIEMBRO: 'inmobiliaria_miembro' },
}));
vi.mock('../../orchestrator/orchestrator.emails', () => ({ sendInvitacionMiembroEmail: vi.fn() }));
vi.mock('../../notificaciones/notificaciones.service', () => ({ notificarUsuario: vi.fn(async () => {}) }));

import { cambiarRolMiembro, salirDeOrg, revocarMiembro } from '../inmobiliaria-miembros.service';

const ownerMembership = {
  data: {
    id: 'm-self',
    inmobiliaria_id: 'org1',
    rol_miembro: 'owner',
    inmobiliarias: { nombre: 'Inmobiliaria X', miembros_ven_todo: true },
  },
};

beforeEach(() => {
  queue = [];
  vi.clearAllMocks();
});

describe('cambiarRolMiembro — protección del último titular', () => {
  it('rechaza degradar al único owner activo (ULTIMO_OWNER)', async () => {
    enqueue(
      ownerMembership, // assertOwner -> resolveMembership
      { data: { id: 'm-self', rol_miembro: 'owner', perfil_id: 'p-self', estado: 'activo', inmobiliaria_id: 'org1' } }, // target
      { count: 1 }, // contarOwnersActivos
    );
    await expect(cambiarRolMiembro('p-self', 'm-self', 'miembro')).rejects.toMatchObject({
      errorCode: 'ULTIMO_OWNER',
    });
  });

  it('no-op si el rol no cambia', async () => {
    enqueue(
      ownerMembership,
      { data: { id: 'm-2', rol_miembro: 'miembro', perfil_id: 'p-2', estado: 'activo', inmobiliaria_id: 'org1' } },
    );
    const r = await cambiarRolMiembro('p-self', 'm-2', 'miembro');
    expect(r.message).toMatch(/no cambió/i);
  });

  it('rechaza si el miembro no está activo', async () => {
    enqueue(
      ownerMembership,
      { data: { id: 'm-3', rol_miembro: 'miembro', perfil_id: null, estado: 'invitado', inmobiliaria_id: 'org1' } },
    );
    await expect(cambiarRolMiembro('p-self', 'm-3', 'owner')).rejects.toMatchObject({
      errorCode: 'MIEMBRO_NO_ACTIVO',
    });
  });
});

describe('salirDeOrg — protección del último titular', () => {
  it('rechaza que el único owner salga (ULTIMO_OWNER)', async () => {
    enqueue(ownerMembership, { count: 1 });
    await expect(salirDeOrg('p-self')).rejects.toMatchObject({ errorCode: 'ULTIMO_OWNER' });
  });

  it('permite salir a un miembro no-titular', async () => {
    enqueue(
      { data: { id: 'm-x', inmobiliaria_id: 'org1', rol_miembro: 'miembro', inmobiliarias: { nombre: 'X', miembros_ven_todo: true } } },
      { error: null }, // update estado revocado
      { error: null }, // liberar inmuebles
      { error: null }, // liberar expedientes
      { data: [] }, // notificarOwnersOrg select (async)
    );
    const r = await salirDeOrg('p-x');
    expect(r.message).toMatch(/saliste/i);
  });

  it('rechaza salir si no perteneces a ninguna org', async () => {
    enqueue({ data: null });
    await expect(salirDeOrg('p-nobody')).rejects.toMatchObject({ errorCode: 'SIN_ORGANIZACION' });
  });
});

describe('revocarMiembro — protección del último titular', () => {
  it('rechaza revocar al único owner (ULTIMO_OWNER)', async () => {
    enqueue(
      ownerMembership, // assertOwner
      { data: { id: 'm-owner2', rol_miembro: 'owner', perfil_id: 'p-owner2', inmobiliaria_id: 'org1' } }, // target
      { count: 1 }, // contarOwnersActivos
    );
    await expect(revocarMiembro('p-self', 'm-owner2')).rejects.toMatchObject({ errorCode: 'ULTIMO_OWNER' });
  });
});
