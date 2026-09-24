import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';

// ============================================================
// authMiddleware: getUser y el perfil van en paralelo (el perfil se adelanta
// con el `sub` del JWT sin verificar y solo vale si getUser confirma el mismo
// id), el resultado se cachea por token y una segunda pasada por el mismo
// request no vuelve a validar.
// ============================================================

const { mockGetUser, mockPerfil, mockRpc } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockPerfil: vi.fn(),
  mockRpc: vi.fn(async (..._a: unknown[]) => ({ data: null, error: null })),
}));

vi.mock('@/lib/supabase', () => ({
  supabaseAuth: { auth: { getUser: (t: string) => mockGetUser(t) } },
  supabase: {
    from: () => ({ select: () => ({ eq: (_c: string, id: string) => ({ single: () => mockPerfil(id) }) }) }),
    rpc: (...a: unknown[]) => mockRpc(...a),
  },
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/tenantScope', () => ({ resolveRolMiembro: vi.fn(async () => 'owner') }));

import { authMiddleware, invalidateAuthCache, cerrarSesionesDe } from '../auth';
import { resolveRolMiembro } from '@/lib/tenantScope';

const ID = '11111111-2222-4333-8444-555555555555';
const OTRO = '99999999-2222-4333-8444-555555555555';
const jwt = (sub: string) =>
  `x.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.firma-${sub}-${Math.random()}`;
const req = (token: string) =>
  ({ headers: { authorization: `Bearer ${token}` }, method: 'GET', originalUrl: '/api/v1/x' }) as unknown as Request;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockImplementation(async () => ({ data: { user: { id: ID, email: 'a@b.co' } }, error: null }));
  mockPerfil.mockImplementation(async (id: string) => ({ data: { id, rol: 'propietario', estado: 'activo' }, error: null }));
});

describe('authMiddleware', () => {
  it('valida y lee el perfil a la vez, y cachea por token', async () => {
    const t = jwt(ID);
    const next = vi.fn();
    const r = req(t);
    await authMiddleware(r, {} as Response, next);
    expect(mockGetUser).toHaveBeenCalledWith(t);
    expect(mockPerfil).toHaveBeenCalledWith(ID);
    expect(r.user).toMatchObject({ id: ID, rol: 'propietario', email: 'a@b.co' });
    await authMiddleware(req(t), {} as Response, next);
    expect(mockGetUser).toHaveBeenCalledTimes(1); // segundo request: del caché
    invalidateAuthCache(ID);
    await authMiddleware(req(t), {} as Response, next);
    expect(mockGetUser).toHaveBeenCalledTimes(2);
  });

  it('un token cuyo sub no es el usuario que confirma getUser es 401 (el perfil adelantado no se usa)', async () => {
    const r = req(jwt(OTRO));
    await expect(authMiddleware(r, {} as Response, vi.fn())).rejects.toMatchObject({ statusCode: 401 });
    expect(r.user).toBeUndefined();
  });

  it('un token sin sub legible es 401 sin llamar a Supabase', async () => {
    await expect(authMiddleware(req('basura'), {} as Response, vi.fn())).rejects.toMatchObject({ statusCode: 401 });
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockPerfil).not.toHaveBeenCalled();
  });

  it('si el request ya pasó por el middleware (otro router en el mismo prefijo), no vuelve a validar', async () => {
    const r = req(jwt(ID));
    r.user = { id: ID, email: 'a@b.co', rol: 'propietario', activo: true };
    const next = vi.fn();
    await authMiddleware(r, {} as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(mockGetUser).not.toHaveBeenCalled();
  });
});

describe('bloqueo de escritura de miembros de una inmobiliaria', () => {
  const rolMiembro = vi.mocked(resolveRolMiembro);
  const post = (path: string) =>
    ({ headers: { authorization: `Bearer ${jwt(ID)}` }, method: 'POST', originalUrl: path }) as unknown as Request;
  const ACEPTAR = '/api/v1/public/invitacion-miembro/tok123/aceptar';

  beforeEach(() => {
    mockPerfil.mockImplementation(async (id: string) => ({ data: { id, rol: 'inmobiliaria', estado: 'activo' }, error: null }));
  });
  afterEach(() => rolMiembro.mockResolvedValue('owner'));

  it('el de sólo lectura puede aceptar una invitación a otro equipo (el servicio responde el 409 claro); lo demás sigue bloqueado', async () => {
    rolMiembro.mockResolvedValue('solo_lectura');
    const next = vi.fn();
    await authMiddleware(post(ACEPTAR), {} as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
    for (const path of [
      '/api/v1/inmuebles',
      `${ACEPTAR}/otra`,
      '/api/v1/inmobiliaria/miembros/invitar',
      '/api/v1/public/invitacion-miembro/tok123/registrar',
    ]) {
      await expect(authMiddleware(post(path), {} as Response, vi.fn())).rejects.toMatchObject({
        statusCode: 403,
        errorCode: 'MIEMBRO_SOLO_LECTURA',
      });
    }
  });

  it('el miembro con perfil incompleto también puede aceptar; lo demás sigue bloqueado', async () => {
    rolMiembro.mockResolvedValue('miembro');
    const next = vi.fn();
    await authMiddleware(post(ACEPTAR), {} as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
    await expect(authMiddleware(post('/api/v1/expedientes'), {} as Response, vi.fn())).rejects.toMatchObject({
      statusCode: 403,
      errorCode: 'PERFIL_PERSONAL_INCOMPLETO',
    });
  });
});

describe('cerrarSesionesDe', () => {
  it('borra sus sesiones por id (signOut pedía el JWT y no cerraba nada) y vacía su caché', async () => {
    const t = jwt(ID);
    await authMiddleware(req(t), {} as Response, vi.fn());
    await cerrarSesionesDe(ID);
    expect(mockRpc).toHaveBeenCalledWith('cerrar_sesiones_usuario', { p_user_id: ID });
    await authMiddleware(req(t), {} as Response, vi.fn());
    expect(mockGetUser).toHaveBeenCalledTimes(2); // el token vuelve a GoTrue
  });
});
