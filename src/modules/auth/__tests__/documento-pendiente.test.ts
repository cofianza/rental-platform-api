import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// GET /auth/me: `documento_pendiente` (H43, registro liviano). Solo para el
// solicitante; la ficha en `solicitantes` manda sobre `perfiles` (misma fuente
// que «Mi cuenta»), y sin ficha cae a perfiles.
// ============================================================

const { mockPerfil, mockFicha } = vi.hoisted(() => ({ mockPerfil: vi.fn(), mockFicha: vi.fn() }));

vi.mock('@/lib/supabase', () => {
  const ficha = { eq: () => ficha, order: () => ficha, limit: () => ficha, maybeSingle: () => mockFicha() };
  return {
    supabaseAuth: { auth: {} },
    supabase: {
      from: (t: string) => ({
        select: () => (t === 'solicitantes' ? ficha : { eq: () => ({ single: () => mockPerfil() }) }),
      }),
    },
  };
});
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/config', () => ({ env: {} }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/lib/email', () => ({ sendPasswordResetEmail: vi.fn() }));
vi.mock('@/lib/tenantScope', () => ({ resolveRolMiembro: vi.fn(async () => null) }));

import { getProfile } from '../auth.service';

const perfil = (rol: string, numero_documento: string | null) => ({
  data: {
    id: 'u1', nombre: 'Ana', apellido: 'Gómez', rol, estado: 'activo', telefono: '300',
    tipo_documento: numero_documento ? 'cc' : null, numero_documento, created_at: 'x', updated_at: 'x',
  },
  error: null,
});
const ficha = (numero_documento: string) => ({ data: { id: 's1', tipo_documento: 'cc', numero_documento } });

beforeEach(() => vi.clearAllMocks());

describe('getProfile · documento_pendiente', () => {
  it('registro liviano: ficha con numero_documento vacío → pendiente', async () => {
    mockPerfil.mockResolvedValue(perfil('solicitante', null));
    mockFicha.mockResolvedValue(ficha(''));
    expect(await getProfile('u1', 'a@b.co', 'solicitante')).toMatchObject({ documento_pendiente: true });
  });

  it('el gestor escribió el documento en la ficha (perfiles vacío) → no pendiente', async () => {
    mockPerfil.mockResolvedValue(perfil('solicitante', null));
    mockFicha.mockResolvedValue(ficha('1020304050'));
    expect(await getProfile('u1', 'a@b.co', 'solicitante')).toMatchObject({ documento_pendiente: false });
  });

  it('sin ficha cae a perfiles; también sin rol de sesión (refresh)', async () => {
    mockPerfil.mockResolvedValue(perfil('solicitante', '1020304050'));
    mockFicha.mockResolvedValue({ data: null });
    expect(await getProfile('u1', 'a@b.co')).toMatchObject({ documento_pendiente: false });
    expect(mockFicha).toHaveBeenCalledTimes(1);
  });

  it('otros roles no traen el campo ni consultan la ficha', async () => {
    mockPerfil.mockResolvedValue(perfil('propietario', null));
    const r = await getProfile('u1', 'a@b.co', 'propietario');
    expect(r).not.toHaveProperty('documento_pendiente');
    expect(mockFicha).not.toHaveBeenCalled();
  });
});
