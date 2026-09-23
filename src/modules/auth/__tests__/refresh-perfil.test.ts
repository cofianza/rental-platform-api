import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

// ============================================================
// POST /auth/refresh devuelve perfil y permisos (al recargar, el front ya no
// espera /auth/me y /auth/permissions en serie) y deja el token nuevo en el
// caché de auth, así la primera petición de la pantalla no paga getUser.
// ============================================================

const { mockRefresh, mockGetUser, mockPerfil } = vi.hoisted(() => ({
  mockRefresh: vi.fn(),
  mockGetUser: vi.fn(),
  mockPerfil: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  supabaseAuth: { auth: { refreshSession: (a: unknown) => mockRefresh(a), getUser: (t: string) => mockGetUser(t) } },
  supabase: {
    from: () => ({ select: () => ({ eq: (_c: string, id: string) => ({ single: () => mockPerfil(id) }) }) }),
  },
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/config', () => ({ env: {} }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/lib/email', () => ({ sendPasswordResetEmail: vi.fn() }));
vi.mock('@/lib/tenantScope', () => ({ resolveRolMiembro: vi.fn(async () => 'owner') }));

import { refreshSession } from '../auth.service';
import { authMiddleware } from '@/middleware/auth';

const ID = '11111111-2222-4333-8444-555555555555';
const TOKEN = `x.${Buffer.from(JSON.stringify({ sub: ID })).toString('base64url')}.firma`;
const perfil = (estado: string) => ({
  id: ID, nombre: 'Ana', apellido: 'Gómez', rol: 'inmobiliaria', estado, telefono: '300', tipo_documento: 'CC',
  numero_documento: '1', created_at: '2026-01-01', updated_at: '2026-01-01',
});

beforeEach(() => {
  vi.clearAllMocks();
  mockRefresh.mockResolvedValue({
    data: { session: { access_token: TOKEN, refresh_token: 'rt-nuevo', expires_at: 123, user: { id: ID, email: 'a@b.co' } } },
    error: null,
  });
});

describe('refreshSession', () => {
  it('trae perfil y permisos, y el token nuevo ya no pasa por getUser', async () => {
    mockPerfil.mockResolvedValue({ data: perfil('activo'), error: null });
    const r = await refreshSession({ refresh_token: 'rt' });
    expect(r).toMatchObject({
      access_token: TOKEN, refresh_token: 'rt-nuevo',
      user: { id: ID, email: 'a@b.co', rol: 'inmobiliaria', rol_miembro: 'owner', activo: true },
    });
    expect('permissions' in r && r.permissions).toBeTruthy();

    const req = { headers: { authorization: `Bearer ${TOKEN}` }, method: 'GET', originalUrl: '/api/v1/x' } as unknown as Request;
    const next = vi.fn();
    await authMiddleware(req, {} as Response, next);
    expect(next).toHaveBeenCalled();
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(req.user).toMatchObject({ id: ID, rol: 'inmobiliaria' });
  });

  it('cuenta desactivada: 403 ACCOUNT_INACTIVE', async () => {
    mockPerfil.mockResolvedValue({ data: perfil('inactivo'), error: null });
    await expect(refreshSession({ refresh_token: 'rt' })).rejects.toMatchObject({ statusCode: 403, errorCode: 'ACCOUNT_INACTIVE' });
  });

  it('si el perfil no se puede leer, igual devuelve los tokens (ya rotaron)', async () => {
    mockPerfil.mockResolvedValue({ data: null, error: { message: 'timeout' } });
    const r = await refreshSession({ refresh_token: 'rt' });
    expect(r).toEqual({ access_token: TOKEN, refresh_token: 'rt-nuevo', expires_at: 123 });
  });
});
