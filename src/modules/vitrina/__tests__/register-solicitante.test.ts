/**
 * Registro del arrendatario desde la vitrina: la ficha que una agencia armó con
 * su correo (sin cuenta) no le impide crear la cuenta. Antes se le respondía
 * "Ya existe una cuenta… Inicia sesión" y no tenía contraseña con qué entrar.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCreateUser, inserts } = vi.hoisted(() => ({
  mockCreateUser: vi.fn(),
  inserts: [] as string[],
}));

vi.mock('@/lib/supabase', () => {
  // La base tiene UNA ficha de agencia con ese correo: cualquier consulta de
  // `solicitantes` filtrada por email la encuentra.
  const chainFor = (tabla: string) => {
    let porEmail = false;
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'in', 'limit', 'update']) chain[m] = () => chain;
    chain.eq = (col: string) => {
      if (col === 'email') porEmail = true;
      return chain;
    };
    chain.insert = () => {
      inserts.push(tabla);
      return chain;
    };
    chain.then = (ok: (v: unknown) => unknown) =>
      Promise.resolve(
        tabla === 'solicitantes' && porEmail
          ? { data: [{ id: 'ficha-de-la-agencia' }], error: null }
          : { data: [], error: null },
      ).then(ok);
    return chain;
  };
  return {
    supabase: { from: (t: string) => chainFor(t) },
    supabaseAuth: {
      auth: {
        admin: { createUser: mockCreateUser, deleteUser: vi.fn() },
        signInWithPassword: async () => ({
          data: { session: { access_token: 'a', refresh_token: 'r', expires_at: 1 } },
          error: null,
        }),
      },
    },
  };
});
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../registration/registration.service', () => ({ recordTermsAcceptance: vi.fn(async () => undefined) }));
vi.mock('../../notificaciones/notificaciones.service', () => ({ notificarUsuario: vi.fn() }));
vi.mock('../../whatsapp', () => ({ enviarTemplate: vi.fn() }));

import { registerSolicitante } from '../vitrina.service';

const input = {
  email: 'persona@correo.co',
  password: 'secreta123',
  confirm_password: 'secreta123',
  nombre: 'Ana',
  apellido: 'Ruiz',
  telefono: '3001234567',
  tipo_documento: 'cc',
  numero_documento: '123456',
  accept_terms: true,
  accept_data_treatment: true,
} as never;

describe('registerSolicitante — correo ya usado en una ficha de agencia', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inserts.length = 0;
  });

  it('crea la cuenta: la ficha de la agencia no es una cuenta', async () => {
    mockCreateUser.mockResolvedValueOnce({ data: { user: { id: 'u-1' } }, error: null });
    const res = await registerSolicitante(input, '1.1.1.1', 'ua');
    expect(mockCreateUser).toHaveBeenCalledOnce();
    expect(res.user.id).toBe('u-1');
    expect(inserts).toContain('solicitantes');
  });

  it('cuenta repetida de verdad: 409 desde auth, sin crear la ficha', async () => {
    mockCreateUser.mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'A user with this email address has already been registered' },
    });
    await expect(registerSolicitante(input, '1.1.1.1', 'ua')).rejects.toMatchObject({
      errorCode: 'EMAIL_ALREADY_EXISTS',
    });
    expect(inserts).toEqual([]);
  });
});
