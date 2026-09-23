import { describe, it, expect, vi, beforeEach } from 'vitest';

// findPerfilIdByEmail resuelve por la RPC find_user_by_email, no por la
// primera página de listUsers (que dejaba sin aviso a las cuentas viejas).

const { mockRpc, mockListUsers } = vi.hoisted(() => ({ mockRpc: vi.fn(), mockListUsers: vi.fn() }));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...a: unknown[]) => mockRpc(...a),
    auth: { admin: { listUsers: (...a: unknown[]) => mockListUsers(...a) } },
  },
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/config', () => ({ env: {} }));
vi.mock('../../orchestrator/orchestrator.emails', () => ({ sendResponsableAsignadoEmail: vi.fn() }));

import { findPerfilIdByEmail } from '../notificaciones.service';

beforeEach(() => {
  mockRpc.mockReset();
  // Una cuenta que no está en la primera página de listUsers.
  mockListUsers.mockResolvedValue({ data: { users: [] }, error: null });
});

describe('findPerfilIdByEmail', () => {
  it('encuentra la cuenta por la RPC con el correo normalizado', async () => {
    mockRpc.mockReturnValue({ maybeSingle: async () => ({ data: { id: 'perfil-viejo' }, error: null }) });
    await expect(findPerfilIdByEmail('  Ana@Correo.COM ')).resolves.toBe('perfil-viejo');
    expect(mockRpc).toHaveBeenCalledWith('find_user_by_email', { user_email: 'ana@correo.com' });
  });

  it('sin cuenta o con error de la RPC devuelve null sin lanzar', async () => {
    mockRpc.mockReturnValue({ maybeSingle: async () => ({ data: null, error: null }) });
    await expect(findPerfilIdByEmail('nadie@correo.com')).resolves.toBeNull();
    mockRpc.mockReturnValue({ maybeSingle: async () => ({ data: null, error: { message: 'boom' } }) });
    await expect(findPerfilIdByEmail('ana@correo.com')).resolves.toBeNull();
    await expect(findPerfilIdByEmail(null)).resolves.toBeNull();
  });
});
