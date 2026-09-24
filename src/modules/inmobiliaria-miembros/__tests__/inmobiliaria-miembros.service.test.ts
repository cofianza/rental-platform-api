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
  // rpc (find_user_by_email) también consume la cola con su maybeSingle.
  supabase: { from: (t: string) => mockFrom(t), rpc: () => chain },
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
const { mockEnviarInvitacion } = vi.hoisted(() => ({ mockEnviarInvitacion: vi.fn() }));
vi.mock('../../orchestrator/orchestrator.emails', () => ({ sendInvitacionMiembroEmail: mockEnviarInvitacion }));
vi.mock('../../notificaciones/notificaciones.service', () => ({ notificarUsuario: vi.fn(async () => {}) }));

import {
  adminRevocarMiembro,
  aceptarInvitacionMiembro,
  getInvitacionMiembroPublic,
  invitarMiembro,
  cambiarRolMiembro,
  salirDeOrg,
  revocarMiembro,
  listMiembros,
} from '../inmobiliaria-miembros.service';
import { invalidateMembresiasCache, resolveRolMiembro } from '@/lib/tenantScope';

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
  // Un titular no "renuncia" a su org (sea o no el único): primero transfiere
  // la titularidad. Por eso ya no se cuenta owners aquí.
  it('rechaza que un owner salga (TITULAR_NO_PUEDE_SALIR)', async () => {
    enqueue(ownerMembership);
    await expect(salirDeOrg('p-self')).rejects.toMatchObject({ errorCode: 'TITULAR_NO_PUEDE_SALIR' });
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

describe('quitar un miembro le quita la cartera (sus inmuebles pasan a la titular)', () => {
  const updates = () =>
    (chain.update as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as Record<string, unknown>);

  it('desde el panel de Cofianza también reapunta sus inmuebles, y renombra el código que choca', async () => {
    enqueue(
      { data: { id: 'org1', nombre: 'X' } }, // getOrgOrThrow
      { data: { id: 'm-x', rol_miembro: 'miembro', perfil_id: 'p-x', estado: 'activo', inmobiliaria_id: 'org1' } },
      { error: null }, // update estado revocado
      { error: null }, // liberar inmuebles
      { error: null }, // liberar expedientes
      { data: { owner_perfil_id: 'p-owner' } }, // titular de la org
      { data: [{ id: 'aaaaaaaa-1', codigo: 'APT-1' }, { id: 'bbbbbbbb-2', codigo: 'APT-9' }] }, // los del saliente
      { data: [{ codigo: 'APT-1' }] }, // los de la titular
      { error: null }, // update inmueble 1
      { error: null }, // update inmueble 2
    );
    await adminRevocarMiembro('admin', 'org1', 'm-x');
    const reapuntados = updates().filter((u) => u.propietario_id === 'p-owner');
    expect(reapuntados).toEqual([
      { propietario_id: 'p-owner', codigo: 'APT-1-aaaa' },
      { propietario_id: 'p-owner' },
    ]);
  });

  it('si no se pueden mover sus inmuebles, falla en vez de decir que quedó fuera', async () => {
    enqueue(
      { data: { id: 'org1', nombre: 'X' } },
      { data: { id: 'm-x', rol_miembro: 'miembro', perfil_id: 'p-x', estado: 'activo', inmobiliaria_id: 'org1' } },
      { error: null },
      { error: null },
      { error: null },
      { data: { owner_perfil_id: 'p-owner' } },
      { data: [{ id: 'aaaaaaaa-1', codigo: 'APT-1' }] },
      { data: [] },
      { error: { message: 'caída' } },
    );
    await expect(adminRevocarMiembro('admin', 'org1', 'm-x')).rejects.toMatchObject({ errorCode: 'INMUEBLES_NO_REASIGNADOS' });
  });
});

describe('cambio de titular principal: los créditos de estudios se van con la titularidad', () => {
  it('al degradar al titular principal, sus lotes/compras/movimientos pasan al nuevo titular', async () => {
    enqueue(
      ownerMembership, // assertOwner
      { data: { id: 'm-self', rol_miembro: 'owner', perfil_id: 'p-self', estado: 'activo', inmobiliaria_id: 'org1' } },
      { count: 2 }, // hay otro titular
      { error: null }, // update rol
      { data: { owner_perfil_id: 'p-self' } }, // era el principal
      { data: { perfil_id: 'p-owner2' } }, // co-titular que queda
      { error: null }, // update owner_perfil_id
      { error: null }, { error: null }, { error: null }, // créditos
    );

    await cambiarRolMiembro('p-self', 'm-self', 'miembro');

    const tablas = mockFrom.mock.calls.map((c) => (c as unknown[])[0]);
    expect(tablas).toEqual(expect.arrayContaining([
      'lotes_creditos_estudios', 'compras_creditos_estudios', 'movimientos_creditos_estudios',
    ]));
    const movidos = (chain.update as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => (c[0] as Record<string, unknown>).perfil_id === 'p-owner2',
    );
    expect(movidos).toHaveLength(3);
    expect(chain.eq).toHaveBeenCalledWith('perfil_id', 'p-self');

    // La agenda de visitas de la organización también se va con él (P37).
    const agenda = (chain.update as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => (c[0] as Record<string, unknown>).propietario_id === 'p-owner2',
    );
    expect(agenda).toHaveLength(3);
    expect(tablas).toEqual(expect.arrayContaining([
      'disponibilidad_propietario', 'configuracion_disponibilidad', 'disponibilidad_fechas_bloqueadas',
    ]));
    expect(chain.delete).toHaveBeenCalledTimes(3); // la agenda personal del nuevo, que ya no se usa
    expect(chain.eq).toHaveBeenCalledWith('propietario_id', 'p-self');
  });
});

describe('listMiembros — la tarjeta del responsable no paga otra ida por la membresía', () => {
  it('usa la membresía que ya cacheó tenantScope al cargar el estudio', async () => {
    invalidateMembresiasCache();
    enqueue({ data: [{ inmobiliaria_id: 'org1', rol_miembro: 'owner', inmobiliarias: { nombre: 'Inmobiliaria X', miembros_ven_todo: false } }], error: null });
    await resolveRolMiembro('p-self'); // la carga del estudio deja la caché caliente
    vi.clearAllMocks();

    const r = await listMiembros('p-self');
    expect(r).toMatchObject({ organizacion: { id: 'org1', nombre: 'Inmobiliaria X' }, soy_owner: true, miembros_ven_todo: false });
    const selects = (chain.select as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(selects.some((s) => s.includes('rol_miembro, inmobiliarias('))).toBe(false);
  });
});

describe('una persona, una inmobiliaria (aceptar la invitación)', () => {
  const invitacionDeB = {
    data: {
      id: 'm-b',
      email: 'asesora@correo.co',
      estado: 'invitado',
      perfil_id: null,
      token_expiracion: null,
      inmobiliaria_id: 'org-b',
      invitado_por: 'p-owner-b',
      inmobiliarias: { nombre: 'Inmobiliaria B' },
    },
    error: null,
  };
  const asesora = { id: 'p-asesora', email: 'asesora@correo.co', rol: 'inmobiliaria' } as never;

  it('activa en otra inmobiliaria: 409 y no se une', async () => {
    enqueue(invitacionDeB, { data: { id: 'm-a' } }); // la invitación, y su membresía activa en A
    await expect(aceptarInvitacionMiembro('tok', asesora)).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'YA_PERTENECE_A_OTRA_INMOBILIARIA',
      message: 'Ya perteneces a otra inmobiliaria. Sal de ella antes de aceptar esta invitación.',
    });
    expect(chain.update).not.toHaveBeenCalled();
    expect(chain.neq).toHaveBeenCalledWith('inmobiliaria_id', 'org-b');
  });

  it('sin otra membresía activa, se une', async () => {
    enqueue(invitacionDeB, { data: null }, { error: null });
    await expect(aceptarInvitacionMiembro('tok', asesora)).resolves.toMatchObject({ redirect: '/dashboard' });
    expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({ perfil_id: 'p-asesora', estado: 'activo' }));
  });
});

describe('un correo de propietario o arrendatario no se une a un equipo', () => {
  const MENSAJE =
    'Ese correo ya tiene una cuenta de propietario o arrendatario en Cofianza y no puede unirse a un equipo. Invita otro correo.';

  it.each(['propietario', 'solicitante'])('invitar un correo con cuenta de %s: 409 y no sale la invitación', async (rol) => {
    enqueue(
      ownerMembership, // assertOwner
      { data: null }, // no hay fila previa para (org, email)
      { data: { id: 'p-otro' } }, // find_user_by_email
      { data: { rol } }, // su perfil
    );
    await expect(invitarMiembro('p-self', { email: 'dueno@correo.co', rol_miembro: 'miembro' })).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'EMAIL_OTRO_ROL',
      message: MENSAJE,
    });
    expect(chain.insert).not.toHaveBeenCalled();
    expect(chain.update).not.toHaveBeenCalled();
    expect(mockEnviarInvitacion).not.toHaveBeenCalled();
  });

  it('con una cuenta del equipo de Cofianza el mensaje no habla de propietario ni arrendatario', async () => {
    enqueue(ownerMembership, { data: null }, { data: { id: 'p-staff' } }, { data: { rol: 'operador_analista' } });
    await expect(invitarMiembro('p-self', { email: 'analista@cofianza.co', rol_miembro: 'miembro' })).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'EMAIL_OTRO_ROL',
      message: 'Ese correo ya tiene una cuenta en Cofianza con otro tipo de acceso y no puede unirse a un equipo. Invita otro correo.',
    });
    expect(mockEnviarInvitacion).not.toHaveBeenCalled();
  });

  it('un correo sin cuenta sí se invita', async () => {
    enqueue(
      ownerMembership,
      { data: null }, // no hay fila previa
      { data: null }, // find_user_by_email: sin cuenta
      { data: { id: 'm-nuevo' }, error: null }, // insert ... select('id')
      { data: null }, // perfil del invitador (correo)
    );
    await expect(invitarMiembro('p-self', { email: 'nueva@correo.co', rol_miembro: 'miembro' })).resolves.toMatchObject({
      reenviada: false,
    });
    expect(mockEnviarInvitacion).toHaveBeenCalledTimes(1);
  });

  const invitacion = {
    data: {
      id: 'm-b',
      email: 'dueno@correo.co',
      estado: 'invitado',
      perfil_id: null,
      token_expiracion: null,
      inmobiliaria_id: 'org1',
      invitado_por: null,
      inmobiliarias: { nombre: 'Inmobiliaria X' },
    },
    error: null,
  };

  it('la página de una invitación ya enviada lo sabe: cuenta_otro_rol dice cuál', async () => {
    enqueue(invitacion, { data: { id: 'p-otro' } }, { data: { rol: 'propietario' } });
    await expect(getInvitacionMiembroPublic('tok')).resolves.toMatchObject({
      tiene_cuenta: true,
      cuenta_otro_rol: 'propietario_o_arrendatario',
    });
    enqueue(invitacion, { data: { id: 'p-staff' } }, { data: { rol: 'administrador' } });
    await expect(getInvitacionMiembroPublic('tok')).resolves.toMatchObject({ tiene_cuenta: true, cuenta_otro_rol: 'interna' });
  });

  it('una cuenta de inmobiliaria o un correo sin cuenta no lo son', async () => {
    enqueue(invitacion, { data: { id: 'p-inmo' } }, { data: { rol: 'inmobiliaria' } });
    await expect(getInvitacionMiembroPublic('tok')).resolves.toMatchObject({ tiene_cuenta: true, cuenta_otro_rol: null });
    enqueue(invitacion, { data: null });
    await expect(getInvitacionMiembroPublic('tok')).resolves.toMatchObject({ tiene_cuenta: false, cuenta_otro_rol: null });
  });
});
