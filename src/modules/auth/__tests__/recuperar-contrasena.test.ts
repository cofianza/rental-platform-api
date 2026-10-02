import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// «Recuperar contraseña» (forgotPassword) y «restablecer» (resetPassword) con
// Supabase simulado: colas de resultados por tabla y `ops` con cada operación,
// también las llamadas a Auth. La RPC find_user_by_email compara EXACTO, como
// la de producción, y la cuenta está en minúsculas, que es como Supabase Auth
// guarda los correos.
// ============================================================

const { mockFrom, mockRpc, ops, enqueue, resetQueues, mockSendReset, mockUpdateUserById } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'update', 'eq', 'is']) {
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    }
    chain.single = async () => next(table);
    chain.maybeSingle = async () => next(table);
    chain.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  const CUENTA = { id: 'user-1', email: 'maria.perez@gmail.com' };
  return {
    mockFrom: vi.fn((table: string) => chainFor(table)),
    mockRpc: vi.fn((_fn: string, args: { user_email: string }) => ({
      single: async () =>
        args.user_email === CUENTA.email
          ? { data: CUENTA, error: null }
          : { data: null, error: { code: 'PGRST116', message: '0 rows' } },
    })),
    ops,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    resetQueues: () => queues.clear(),
    mockSendReset: vi.fn(async (..._args: unknown[]) => undefined),
    mockUpdateUserById: vi.fn(async (...args: unknown[]): Promise<{ error: { message: string } | null }> => {
      ops.push({ table: 'auth', method: 'updateUserById', args });
      return { error: null };
    }),
  };
});

vi.mock('@/lib/supabase', () => ({
  supabase: { from: (t: string) => mockFrom(t), rpc: (fn: string, args: { user_email: string }) => mockRpc(fn, args) },
  supabaseAuth: { auth: { admin: { updateUserById: mockUpdateUserById } } },
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/config', () => ({ env: { FRONTEND_URL: 'https://www.cofianza.co' } }));
vi.mock('@/lib/auditLog', () => ({
  logAudit: vi.fn(),
  AUDIT_ACTIONS: { PASSWORD_RESET_REQUEST: 'password_reset_request', PASSWORD_RESET_COMPLETE: 'password_reset_complete' },
  AUDIT_ENTITIES: { USER: 'user', SESSION: 'session' },
}));
vi.mock('@/lib/email', () => ({ sendPasswordResetEmail: mockSendReset }));
vi.mock('@/lib/tenantScope', () => ({ resolveRolMiembro: vi.fn() }));
vi.mock('@/middleware/auth', () => ({ cerrarSesionesDe: vi.fn(), invalidateAuthCache: vi.fn(), primeAuthCache: vi.fn() }));

import { forgotPassword, resetPassword } from '../auth.service';
import { forgotPasswordSchema } from '../auth.schema';
import { logger } from '@/lib/logger';
import { logAudit } from '@/lib/auditLog';
import { cerrarSesionesDe } from '@/middleware/auth';

beforeEach(() => {
  resetQueues();
  ops.length = 0;
  vi.clearAllMocks();
});

describe('forgotPassword', () => {
  it('con el correo escrito con mayúsculas encuentra la cuenta y envía el enlace', async () => {
    // Tal como llega del formulario: lo normaliza el schema de la ruta.
    await forgotPassword(forgotPasswordSchema.parse({ email: 'Maria.Perez@Gmail.COM' }), '1.2.3.4');

    expect(mockRpc).toHaveBeenCalledWith('find_user_by_email', { user_email: 'maria.perez@gmail.com' });
    expect(ops.some((o) => o.table === 'password_reset_tokens' && o.method === 'insert')).toBe(true);
    expect(mockSendReset).toHaveBeenCalledWith(
      'maria.perez@gmail.com',
      expect.stringMatching(/^https:\/\/www\.cofianza\.co\/restablecer-contrasena\?token=[a-f0-9]{64}$/),
    );
  });

  it('un correo sin cuenta no guarda token ni envía nada (misma respuesta para quien pregunta)', async () => {
    await expect(forgotPassword(forgotPasswordSchema.parse({ email: 'nadie@gmail.com' }))).resolves.toBeUndefined();

    expect(ops).toHaveLength(0);
    expect(mockSendReset).not.toHaveBeenCalled();
  });

  // Resend no lanza cuando rechaza un correo; email.ts ahora sí. Si forgotPassword
  // dejara pasar ese error, el 500 saldría solo con los correos que tienen cuenta.
  it('si el proveedor rechaza el correo, responde igual que siempre y queda el motivo en el log', async () => {
    mockSendReset.mockRejectedValueOnce(new Error('Resend validation_error: The notify.cofianza.co domain is not verified'));

    await expect(forgotPassword({ email: 'maria.perez@gmail.com' }, '1.2.3.4')).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'maria.perez@gmail.com',
        error: 'Resend validation_error: The notify.cofianza.co domain is not verified',
      }),
      'No se pudo enviar el email de recuperación',
    );
    expect(vi.mocked(logger.info).mock.calls.some(([, msg]) => String(msg).includes('enviado'))).toBe(false);
    // El pedido sí queda en la bitácora: ocurrió, aunque el correo no saliera.
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ accion: 'password_reset_request', usuarioId: 'user-1' }));
  });

  it('si sale, queda como enviado', async () => {
    await forgotPassword({ email: 'maria.perez@gmail.com' }, '1.2.3.4');
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }), 'Token de reset generado y email enviado');
    expect(logger.error).not.toHaveBeenCalled();
  });
});

// Una cuenta recién registrada que aún no verificó el correo podía restablecer
// la clave y seguía sin poder entrar. El enlace de recuperación llegó a ese
// mismo correo: completarlo la deja verificada, igual que el enlace de
// verificación (misma función). Nunca reactiva otra clase de cuenta.
describe('resetPassword', () => {
  const TOKENS = 'password_reset_tokens';
  const enlace = () => ({
    data: { id: 'reset-1', user_id: 'user-1', expires_at: new Date(Date.now() + 3_600_000).toISOString(), used_at: null },
    error: null,
  });
  const restablecer = () => resetPassword({ token: 'a'.repeat(64), password: 'NuevaClave123' }, '1.2.3.4');
  /** Escrituras en orden: lo que recibió Auth y los UPDATE de cada tabla. */
  const escrituras = () =>
    ops
      .filter((o) => o.method === 'update' || o.method === 'updateUserById')
      .map((o) => (o.table === 'auth' ? `auth:${Object.keys(o.args[1] as object).join()}` : o.table));

  it('autorregistro sin verificar: cambia la clave, deja la cuenta verificada y activa, y gasta el enlace', async () => {
    enqueue(TOKENS, enlace());
    enqueue('perfiles', { data: { registration_source: 'email', email_verified_at: null }, error: null });

    await expect(restablecer()).resolves.toMatchObject({ message: expect.any(String) });

    expect(escrituras()).toEqual(['auth:password', 'auth:email_confirm', 'perfiles', TOKENS]);
    expect(mockUpdateUserById).toHaveBeenCalledWith('user-1', { email_confirm: true });
    const perfil = ops.find((o) => o.table === 'perfiles' && o.method === 'update')!.args[0];
    expect(perfil).toMatchObject({ estado: 'activo', email_verified_at: expect.any(String) });
    expect(cerrarSesionesDe).toHaveBeenCalledWith('user-1');
  });

  it.each([
    ['ya verificada (la pudo desactivar un administrador)', { registration_source: 'email', email_verified_at: '2026-09-01T00:00:00Z' }],
    ['creada por un administrador', { registration_source: 'admin', email_verified_at: null }],
    ['de la vitrina', { registration_source: 'vitrina_publica', email_verified_at: null }],
  ])('cuenta %s: solo cambia la clave, no la activa', async (_caso, estado) => {
    enqueue(TOKENS, enlace());
    enqueue('perfiles', { data: estado, error: null });

    await expect(restablecer()).resolves.toMatchObject({ message: expect.any(String) });

    expect(escrituras()).toEqual(['auth:password', TOKENS]);
  });

  it('si la activación falla: error, y el enlace queda sin gastar para reintentar', async () => {
    enqueue(TOKENS, enlace());
    enqueue('perfiles', { data: { registration_source: 'email', email_verified_at: null }, error: null }, { error: { message: 'connection reset' } });

    await expect(restablecer()).rejects.toMatchObject({ statusCode: 500 });

    expect(escrituras()).toEqual(['auth:password', 'auth:email_confirm', 'perfiles']);
    expect(cerrarSesionesDe).not.toHaveBeenCalled();
  });

  it('enlace desconocido, usado o vencido: 400 y no cambia nada', async () => {
    enqueue(TOKENS, { data: null, error: { code: 'PGRST116', message: '0 rows' } });
    await expect(restablecer()).rejects.toMatchObject({ statusCode: 400, errorCode: 'INVALID_RESET_TOKEN' });

    enqueue(TOKENS, { data: { id: 'reset-1', user_id: 'user-1', expires_at: new Date(Date.now() - 1000).toISOString(), used_at: null }, error: null });
    await expect(restablecer()).rejects.toMatchObject({ statusCode: 400, errorCode: 'INVALID_RESET_TOKEN' });

    expect(escrituras()).toEqual([]);
  });
});
