import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Mock supabase: builder encadenable + cola de resultados.
// Cada método de filtro devuelve el mismo builder; los terminales
// (maybeSingle/single) y el `await` directo del builder (count/update/delete)
// consumen el siguiente resultado de la cola, en orden de llamada.
// Un resultado puede ser una función de la consulta que lo pide (tabla y
// filtros), para probar QUÉ se filtró; solo en consultas que no van en paralelo.
// ============================================================

type Resultado = Record<string, unknown>;
type Consulta = { tabla: string; filtros: unknown[][] };
let queue: Array<Resultado | ((c: Consulta) => Resultado)> = [];
const enqueue = (...items: Array<Resultado | ((c: Consulta) => Resultado)>) => queue.push(...items);
let consulta: Consulta = { tabla: '', filtros: [] };
const nextResult = (): Resultado => {
  const r = queue.length ? queue.shift()! : { data: null, error: null, count: null };
  return typeof r === 'function' ? r(consulta) : r;
};

const chain: Record<string, unknown> = {};
const passthrough = ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'is', 'not', 'in', 'or', 'lt', 'gt', 'gte', 'lte', 'order', 'limit'];
passthrough.forEach((m) => {
  chain[m] = vi.fn((...args: unknown[]) => {
    consulta.filtros.push([m, ...args]);
    return chain;
  });
});
chain.maybeSingle = vi.fn(async () => nextResult());
chain.single = vi.fn(async () => nextResult());
// Hace al builder "thenable" para los queries que se await-ean sin maybeSingle.
chain.then = (resolve: (v: Record<string, unknown>) => unknown) => resolve(nextResult());

const mockFrom = vi.fn((t: string) => {
  consulta = { tabla: t, filtros: [] };
  return chain;
});

vi.mock('@/lib/supabase', () => ({
  // rpc (find_user_by_email) también consume la cola con su maybeSingle.
  supabase: {
    from: (t: string) => mockFrom(t),
    rpc: (fn: string) => {
      consulta = { tabla: `rpc:${fn}`, filtros: [] };
      return chain;
    },
  },
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
    INMOBILIARIA_CERRADA: 'inmobiliaria_cerrada',
  },
  AUDIT_ENTITIES: { INMOBILIARIA_MIEMBRO: 'inmobiliaria_miembro', INMOBILIARIA: 'inmobiliaria' },
}));
const { mockEnviarInvitacion } = vi.hoisted(() => ({ mockEnviarInvitacion: vi.fn() }));
vi.mock('../../orchestrator/orchestrator.emails', () => ({ sendInvitacionMiembroEmail: mockEnviarInvitacion }));
vi.mock('../../notificaciones/notificaciones.service', () => ({ notificarUsuario: vi.fn(async () => {}) }));

import {
  adminRevocarMiembro,
  aceptarInvitacionMiembro,
  getInvitacionMiembroPublic,
  invitarMiembro,
  reenviarInvitacion,
  cambiarRolMiembro,
  salirDeOrg,
  revocarMiembro,
  listMiembros,
} from '../inmobiliaria-miembros.service';
import { invalidateMembresiasCache, resolveRolMiembro } from '@/lib/tenantScope';
import { logAudit } from '@/lib/auditLog';

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

// Revisión de la inmobiliaria del titular: equipo (otros activos), inmuebles,
// estudios en curso, fichas, créditos sin usar, compras de créditos pendientes.
const inmobiliariaVacia = () => [{ data: [] }, { count: 0 }, { count: 0 }, { count: 0 }, { count: 0 }, { count: 0 }];
const updates = () => (chain.update as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as Record<string, unknown>);

describe('salirDeOrg — protección del último titular', () => {
  // Un titular no "renuncia" a una org con equipo o cartera: primero deja de
  // ser titular (traspasa la titularidad o se pasa a miembro).
  it('el titular de una inmobiliaria con equipo no sale: TITULAR_NO_PUEDE_SALIR con traspasar la titularidad', async () => {
    const r = inmobiliariaVacia();
    r[0] = { data: [{ rol_miembro: 'miembro' }] };
    enqueue(ownerMembership, ...r);
    await expect(salirDeOrg('p-self')).rejects.toMatchObject({
      errorCode: 'TITULAR_NO_PUEDE_SALIR',
      message: 'Eres el titular de la inmobiliaria y tiene equipo o cartera: traspasa la titularidad a otro miembro o pide a Cofianza que la cierre.',
    });
    expect(chain.update).not.toHaveBeenCalled();
  });

  it('el cotitular no sale: primero se pasa a miembro', async () => {
    const r = inmobiliariaVacia();
    r[0] = { data: [{ rol_miembro: 'owner' }] };
    enqueue(ownerMembership, ...r);
    await expect(salirDeOrg('p-self')).rejects.toMatchObject({
      errorCode: 'TITULAR_NO_PUEDE_SALIR',
      message: 'Eres cotitular de la inmobiliaria: primero cambia tu rol a miembro y luego sal.',
    });
    expect(chain.update).not.toHaveBeenCalled();
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
const activada = { data: { id: 'm-b' }, error: null };

describe('una persona, una inmobiliaria (aceptar la invitación)', () => {
  it('miembro activo de otra inmobiliaria: 409 y no se une', async () => {
    enqueue(invitacionDeB, { data: { id: 'm-a', inmobiliaria_id: 'org-a', rol_miembro: 'miembro' } });
    await expect(aceptarInvitacionMiembro('tok', asesora)).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'YA_PERTENECE_A_OTRA_INMOBILIARIA',
      message: 'Ya perteneces a otra inmobiliaria. Sal de ella antes de aceptar esta invitación.',
    });
    expect(chain.update).not.toHaveBeenCalled();
    expect(chain.neq).toHaveBeenCalledWith('inmobiliaria_id', 'org-b');
  });

  it('sin otra membresía activa, se une', async () => {
    enqueue(invitacionDeB, { data: null }, activada);
    await expect(aceptarInvitacionMiembro('tok', asesora)).resolves.toMatchObject({ redirect: '/dashboard' });
    expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({ perfil_id: 'p-asesora', estado: 'activo' }));
  });

  it('una membresía revocada en otra inmobiliaria no cuenta: la consulta es de las activas', async () => {
    const soloRevocadaEnA = (c: Consulta) =>
      c.filtros.some(([m, col, v]) => m === 'eq' && col === 'estado' && v === 'activo')
        ? { data: null }
        : { data: { id: 'm-vieja', inmobiliaria_id: 'org-a', rol_miembro: 'miembro' } };
    enqueue(invitacionDeB, soloRevocadaEnA, activada);
    await expect(aceptarInvitacionMiembro('tok', asesora)).resolves.toMatchObject({ redirect: '/dashboard' });
  });

  it('la activación es condicional: sigue pendiente y es para esta persona; si no, 409', async () => {
    enqueue(invitacionDeB, { data: null }, { data: null, error: null }, { data: { estado: 'revocado', perfil_id: null } });
    await expect(aceptarInvitacionMiembro('tok', asesora)).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'INVITACION_NO_VIGENTE',
    });
    expect(chain.eq).toHaveBeenCalledWith('estado', 'invitado');
    expect(chain.or).toHaveBeenCalledWith('perfil_id.is.null,perfil_id.eq.p-asesora');
  });

  it('dos aceptaciones a la vez: el 23505 del índice único es el mismo 409, no un 500', async () => {
    enqueue(invitacionDeB, { data: null }, {
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint "idx_inmob_miembro_una_activa_por_perfil"' },
    });
    await expect(aceptarInvitacionMiembro('tok', asesora)).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'YA_PERTENECE_A_OTRA_INMOBILIARIA',
    });
  });

  it('doble clic: la segunda no toca filas, relee y ve que ya es suya: éxito, no 409', async () => {
    enqueue(invitacionDeB, { data: null }, { data: null, error: null }, { data: { estado: 'activo', perfil_id: 'p-asesora' } });
    await expect(aceptarInvitacionMiembro('tok', asesora)).resolves.toMatchObject({ redirect: '/dashboard' });
  });

  it('activa con OTRO perfil no cuenta como suya: 409', async () => {
    enqueue(invitacionDeB, { data: null }, { data: null, error: null }, { data: { estado: 'activo', perfil_id: 'p-otra' } });
    await expect(aceptarInvitacionMiembro('tok', asesora)).rejects.toMatchObject({ errorCode: 'INVITACION_NO_VIGENTE' });
  });

  it('si no se puede verificar la otra membresía, no se une (503)', async () => {
    enqueue(invitacionDeB, { data: null, error: { message: 'caída' } });
    await expect(aceptarInvitacionMiembro('tok', asesora)).rejects.toMatchObject({
      statusCode: 503,
      errorCode: 'MEMBRESIA_NO_VERIFICABLE',
    });
    expect(chain.update).not.toHaveBeenCalled();
  });

  it('el exmiembro reinvitado (conserva su perfil_id) puede volver a aceptar', async () => {
    enqueue({ data: { ...invitacionDeB.data, perfil_id: 'p-asesora' }, error: null }, { data: null }, activada);
    await expect(aceptarInvitacionMiembro('tok', asesora)).resolves.toMatchObject({ redirect: '/dashboard' });
  });
});

describe('titular de otra inmobiliaria que acepta una invitación: 409 según su caso, sin tocar nada', () => {
  const titular = { id: 'p-titular', email: 'asesora@correo.co', rol: 'inmobiliaria' } as never;
  const suInmobiliaria = {
    data: { id: 'm-a', inmobiliaria_id: 'org-a', rol_miembro: 'owner', inmobiliarias: { nombre: 'Inmobiliaria A' } },
  };
  // equipo (otros activos), inmuebles, estudios en curso, fichas, créditos, compras pendientes
  const vacia = () => [{ data: [] }, { count: 0 }, { count: 0 }, { count: 0 }, { count: 0 }, { count: 0 }];

  it('única titular de una inmobiliaria vacía: 409 con puede_cerrar y el nombre, y no cierra nada', async () => {
    enqueue(invitacionDeB, suInmobiliaria, ...vacia());
    await expect(aceptarInvitacionMiembro('tok', titular)).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'TITULAR_DE_OTRA_INMOBILIARIA',
      message: 'Eres titular de Inmobiliaria A, que no tiene equipo ni cartera. Ciérrala para aceptar esta invitación.',
      details: { puede_cerrar: true, inmobiliaria: 'Inmobiliaria A' },
    });
    expect(chain.update).not.toHaveBeenCalled();
  });

  it.each([
    ['otro miembro activo', 0, { data: [{ rol_miembro: 'miembro' }] }],
    ['inmuebles', 1, { count: 1 }],
    ['estudios en curso', 2, { count: 1 }],
    ['fichas de solicitantes', 3, { count: 1 }],
    ['créditos sin usar', 4, { count: 1 }],
    ['una compra de créditos pendiente', 5, { count: 1 }],
  ])('con %s: 409 de traspasar la titularidad, sin puede_cerrar', async (_caso, i, valor) => {
    const r = vacia();
    r[i as number] = valor as never;
    enqueue(invitacionDeB, suInmobiliaria, ...r);
    const e = await aceptarInvitacionMiembro('tok', titular).catch((x: unknown) => x as { details?: unknown });
    expect(e).toMatchObject({
      statusCode: 409,
      errorCode: 'TITULAR_DE_OTRA_INMOBILIARIA',
      message:
        'Eres titular de otra inmobiliaria con equipo o cartera activa. Traspasa la titularidad o pide a Cofianza que la cierre antes de aceptar esta invitación.',
    });
    expect(e.details).toBeUndefined();
    expect(chain.update).not.toHaveBeenCalled();
  });

  it('cotitular: no se le habla de traspasar la titularidad', async () => {
    const r = vacia();
    r[0] = { data: [{ rol_miembro: 'owner' }] } as never;
    enqueue(invitacionDeB, suInmobiliaria, ...r);
    await expect(aceptarInvitacionMiembro('tok', titular)).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'TITULAR_DE_OTRA_INMOBILIARIA',
      message: 'Eres cotitular de otra inmobiliaria. Cambia tu rol a miembro en su equipo y sal de ella antes de aceptar esta invitación.',
    });
  });

  it('si no se puede revisar su inmobiliaria: 503', async () => {
    const r = vacia();
    r[3] = { count: null, error: { message: 'caída' } } as never;
    enqueue(invitacionDeB, suInmobiliaria, ...r);
    await expect(aceptarInvitacionMiembro('tok', titular)).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('un correo con una cuenta que no es de inmobiliaria no se une a un equipo', () => {
  const MENSAJE =
    'Ese correo ya tiene una cuenta en Cofianza que no es de inmobiliaria y no puede unirse a un equipo. Invita otro correo.';

  it.each(['propietario', 'solicitante', 'operador_analista'])(
    'invitar un correo con cuenta de %s: 409 con el mismo mensaje (no dice qué cuenta es) y no sale la invitación',
    async (rol) => {
      enqueue(
        ownerMembership, // assertOwner
        { data: null }, // no hay fila previa para (org, email)
        { data: { id: 'p-otro' } }, // find_user_by_email
        { data: { rol } }, // su perfil
      );
      await expect(invitarMiembro('p-self', { email: 'otro@correo.co', rol_miembro: 'miembro' })).rejects.toMatchObject({
        statusCode: 409,
        errorCode: 'EMAIL_OTRO_ROL',
        message: MENSAJE,
      });
      expect(chain.insert).not.toHaveBeenCalled();
      expect(chain.update).not.toHaveBeenCalled();
      expect(mockEnviarInvitacion).not.toHaveBeenCalled();
    },
  );

  it('reenviar la invitación a un correo que ya tiene otra cuenta: el mismo 409 y no sale el correo', async () => {
    enqueue(
      ownerMembership,
      { data: { id: 'm-x', email: 'otro@correo.co', estado: 'invitado', inmobiliaria_id: 'org1' } },
      { data: { id: 'p-otro' } },
      { data: { rol: 'propietario' } },
    );
    await expect(reenviarInvitacion('p-self', 'm-x')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'EMAIL_OTRO_ROL',
      message: MENSAJE,
    });
    expect(chain.update).not.toHaveBeenCalled();
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
      email: 'otro@correo.co',
      estado: 'invitado',
      perfil_id: null,
      token_expiracion: null,
      inmobiliaria_id: 'org1',
      invitado_por: null,
      inmobiliarias: { nombre: 'Inmobiliaria X' },
    },
    error: null,
  };

  it.each(['propietario', 'administrador'])('la página de una invitación ya enviada lo sabe (cuenta de %s)', async (rol) => {
    enqueue(invitacion, { data: { id: 'p-otro' } }, { data: { rol } });
    await expect(getInvitacionMiembroPublic('tok')).resolves.toMatchObject({ tiene_cuenta: true, cuenta_otro_rol: true });
  });

  it('una cuenta de inmobiliaria o un correo sin cuenta no lo son', async () => {
    enqueue(invitacion, { data: { id: 'p-inmo' } }, { data: { rol: 'inmobiliaria' } });
    await expect(getInvitacionMiembroPublic('tok')).resolves.toMatchObject({ tiene_cuenta: true, cuenta_otro_rol: false });
    enqueue(invitacion, { data: null });
    await expect(getInvitacionMiembroPublic('tok')).resolves.toMatchObject({ tiene_cuenta: false, cuenta_otro_rol: false });
  });
});

describe('el titular único de una inmobiliaria vacía la cierra al salir', () => {
  it('revoca su membresía y las invitaciones pendientes, la marca cerrada (sin borrar nada) y queda en la bitácora', async () => {
    enqueue(ownerMembership, ...inmobiliariaVacia(), { error: null }, { error: null }, { count: 0 });
    await expect(salirDeOrg('p-self')).resolves.toEqual({ message: 'Cerraste tu inmobiliaria' });
    expect(updates()).toEqual([{ estado: 'revocado', token: null, token_expiracion: null }, { estado: 'cerrada' }]);
    expect(chain.or).toHaveBeenCalledWith('id.eq.m-self,estado.eq.invitado');
    expect(chain.eq).toHaveBeenCalledWith('estado', 'activa'); // solo cierra una activa
    expect(chain.delete).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ accion: 'inmobiliaria_cerrada', entidadId: 'org1' }));
  });

  it('con cartera (p. ej. una ficha de solicitante) no la cierra', async () => {
    const r = inmobiliariaVacia();
    r[3] = { count: 1 };
    enqueue(ownerMembership, ...r);
    await expect(salirDeOrg('p-self')).rejects.toMatchObject({ errorCode: 'TITULAR_NO_PUEDE_SALIR' });
    expect(chain.update).not.toHaveBeenCalled();
  });

  it('si alguien aceptó entre la revisión y la revocación: la reabre y responde 409', async () => {
    enqueue(
      ownerMembership,
      ...inmobiliariaVacia(),
      { error: null }, // revoca
      { error: null }, // cerrada
      { count: 1 }, // recuento: apareció un miembro
      { data: null }, // ¿ya está activa en otra? no
      { error: null }, // reactiva su membresía
      { error: null }, // la inmobiliaria vuelve a activa
    );
    await expect(salirDeOrg('p-self')).rejects.toMatchObject({ statusCode: 409, errorCode: 'INMOBILIARIA_CON_EQUIPO' });
    expect(updates().slice(-2)).toEqual([{ estado: 'activo' }, { estado: 'activa' }]);
    // Solo deshace lo que hizo el cierre: una membresía revocada y una inmobiliaria cerrada.
    expect(chain.eq).toHaveBeenCalledWith('estado', 'revocado');
    expect(chain.eq).toHaveBeenCalledWith('estado', 'cerrada');
    expect(logAudit).not.toHaveBeenCalledWith(expect.objectContaining({ accion: 'inmobiliaria_cerrada' }));
  });

  it('al reabrir, si la persona ya está activa en otra inmobiliaria no se reactiva su membresía', async () => {
    enqueue(
      ownerMembership,
      ...inmobiliariaVacia(),
      { error: null },
      { error: null },
      { count: 1 },
      { data: { id: 'm-b' } }, // ya está activa en otra
      { error: null }, // solo la inmobiliaria vuelve a activa
    );
    await expect(salirDeOrg('p-self')).rejects.toMatchObject({ errorCode: 'INMOBILIARIA_CON_EQUIPO' });
    expect(updates()).not.toContainEqual({ estado: 'activo' });
    expect(updates().at(-1)).toEqual({ estado: 'activa' });
  });
});

describe('listMiembros — puede_cerrar', () => {
  const soloYo = {
    data: [{ id: 'm-self', email: 'yo@correo.co', rol_miembro: 'owner', estado: 'activo', perfil_id: 'p-self', created_at: '2026-09-01', token_expiracion: null, perfiles: null }],
    error: null,
  };
  const membresia = { data: [{ inmobiliaria_id: 'org1', rol_miembro: 'owner', inmobiliarias: { nombre: 'Inmobiliaria X', miembros_ven_todo: true } }], error: null };

  it('titular único de una inmobiliaria vacía: true', async () => {
    invalidateMembresiasCache();
    // membresía, limpieza de vencidas, carga por miembro, la lista (en ese orden de resolución)
    enqueue(membresia, { error: null, count: 0 }, { data: [] }, soloYo, ...inmobiliariaVacia());
    await expect(listMiembros('p-self')).resolves.toMatchObject({ soy_owner: true, puede_cerrar: true });
  });

  it('con cartera: false', async () => {
    invalidateMembresiasCache();
    const r = inmobiliariaVacia();
    r[1] = { count: 2 };
    enqueue(membresia, { error: null, count: 0 }, { data: [] }, soloYo, ...r);
    await expect(listMiembros('p-self')).resolves.toMatchObject({ puede_cerrar: false });
  });
});
