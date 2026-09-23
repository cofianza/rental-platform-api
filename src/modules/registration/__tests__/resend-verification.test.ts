import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock de Supabase: `perfil` es lo que devuelve la lectura de perfiles;
// `ops` registra cada escritura por tabla.
const { perfil, ops, mockFrom, mockRpc, mockSendEmail } = vi.hoisted(() => {
  const perfil: { current: unknown } = { current: null };
  const ops: Array<{ tabla: string; op: string }> = [];
  const mockFrom = vi.fn((tabla: string) => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.is = () => chain;
    chain.single = async () => ({ data: perfil.current, error: null });
    chain.update = () => { ops.push({ tabla, op: 'update' }); return chain; };
    chain.insert = async () => { ops.push({ tabla, op: 'insert' }); return { error: null }; };
    return chain;
  });
  const mockRpc = vi.fn(() => ({
    single: async () => ({ data: { id: 'user-1', email: 'x@y.co' }, error: null }),
  }));
  return { perfil, ops, mockFrom, mockRpc, mockSendEmail: vi.fn(async () => undefined) };
});

vi.mock('@/lib/supabase', () => ({
  supabase: { from: (t: string) => mockFrom(t), rpc: () => mockRpc() },
  supabaseAuth: {},
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/config', () => ({ env: { FRONTEND_URL: 'http://localhost:3000' } }));
vi.mock('@/lib/email', () => ({ sendVerificationEmail: mockSendEmail }));
vi.mock('@/lib/tenantScope', () => ({ ensureOrgConOwner: vi.fn() }));

import { resendVerification } from '../registration.service';

const tokensInsertados = () =>
  ops.filter((o) => o.tabla === 'email_verification_tokens' && o.op === 'insert').length;

describe('resendVerification — no reactiva cuentas desactivadas', () => {
  beforeEach(() => {
    ops.length = 0;
    mockSendEmail.mockClear();
  });

  it('cuenta creada por el administrador y desactivada: no emite token', async () => {
    perfil.current = { email_verified_at: null, nombre: 'Ex', registration_source: null, estado: 'inactivo' };
    await resendVerification({ email: 'x@y.co' });
    expect(tokensInsertados()).toBe(0);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('cuenta de la vitrina: no emite token', async () => {
    perfil.current = { email_verified_at: null, nombre: 'V', registration_source: 'vitrina_publica' };
    await resendVerification({ email: 'x@y.co' });
    expect(tokensInsertados()).toBe(0);
  });

  it('autoregistro por correo ya verificado: no emite token', async () => {
    perfil.current = { email_verified_at: '2026-09-01T00:00:00Z', nombre: 'P', registration_source: 'email' };
    await resendVerification({ email: 'x@y.co' });
    expect(tokensInsertados()).toBe(0);
  });

  it('autoregistro por correo pendiente: si emite token', async () => {
    perfil.current = { email_verified_at: null, nombre: 'P', registration_source: 'email' };
    await resendVerification({ email: 'x@y.co' });
    expect(tokensInsertados()).toBe(1);
    expect(mockSendEmail).toHaveBeenCalledOnce();
  });
});
