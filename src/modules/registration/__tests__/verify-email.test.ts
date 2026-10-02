import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// verifyEmail: confirma en Auth, activa el perfil y solo al final gasta el
// enlace, revisando cada escritura. Antes marcaba el enlace como usado de
// entrada y no miraba ningún error: un fallo a medias respondía «verificado» y
// dejaba a la persona sin cuenta activa y sin enlace.
// Mock de Supabase con colas por tabla; `ops` lleva también la llamada a Auth.
// ============================================================

const { mockFrom, ops, enqueue, resetQueues, mockUpdateUserById } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'update', 'eq']) {
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    }
    chain.maybeSingle = async () => next(table);
    chain.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  return {
    mockFrom: vi.fn((table: string) => chainFor(table)),
    ops,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    resetQueues: () => queues.clear(),
    mockUpdateUserById: vi.fn(async (...args: unknown[]): Promise<{ error: { message: string } | null }> => {
      ops.push({ table: 'auth', method: 'updateUserById', args });
      return { error: null };
    }),
  };
});

vi.mock('@/lib/supabase', () => ({
  supabase: { from: (t: string) => mockFrom(t) },
  supabaseAuth: { auth: { admin: { updateUserById: mockUpdateUserById } } },
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/config', () => ({ env: { FRONTEND_URL: 'http://localhost:3000' } }));
vi.mock('@/lib/email', () => ({ sendVerificationEmail: vi.fn() }));
vi.mock('@/lib/tenantScope', () => ({ ensureOrgConOwner: vi.fn() }));

import { verifyEmail } from '../registration.service';

const TOKENS = 'email_verification_tokens';
const enlace = (extra: Record<string, unknown> = {}) => ({
  data: { id: 'tok-1', user_id: 'user-1', expires_at: new Date(Date.now() + 3_600_000).toISOString(), used_at: null, ...extra },
  error: null,
});
const PENDIENTE = { data: { registration_source: 'email', email_verified_at: null }, error: null };
const FALLO = { error: { message: 'connection reset' } };

/** Escrituras en el orden en que ocurrieron: «auth», «perfiles» o la tabla de tokens. */
const escrituras = () => ops.filter((o) => o.method === 'update' || o.method === 'updateUserById').map((o) => o.table);

beforeEach(() => {
  resetQueues();
  ops.length = 0;
  mockUpdateUserById.mockClear();
});

describe('verifyEmail', () => {
  it('confirma en Auth, activa el perfil y al final gasta el enlace', async () => {
    enqueue(TOKENS, enlace());
    enqueue('perfiles', PENDIENTE);

    await expect(verifyEmail('a'.repeat(64))).resolves.toMatchObject({ message: expect.stringContaining('verificado') });

    expect(escrituras()).toEqual(['auth', 'perfiles', TOKENS]);
    expect(mockUpdateUserById).toHaveBeenCalledWith('user-1', { email_confirm: true });
    const perfil = ops.find((o) => o.table === 'perfiles' && o.method === 'update')!.args[0];
    expect(perfil).toMatchObject({ estado: 'activo', email_verified_at: expect.any(String) });
    expect(ops.find((o) => o.table === TOKENS && o.method === 'update')!.args[0]).toMatchObject({ used_at: expect.any(String) });
  });

  it('si falla la confirmación en Auth: error, y ni el perfil ni el enlace se tocan', async () => {
    enqueue(TOKENS, enlace());
    enqueue('perfiles', PENDIENTE);
    mockUpdateUserById.mockResolvedValueOnce({ error: { message: 'upstream connect error' } });

    await expect(verifyEmail('a'.repeat(64))).rejects.toMatchObject({ statusCode: 500 });
    expect(escrituras()).toEqual([]);
  });

  it('si falla la activación del perfil: error, y el enlace queda sin gastar para reintentar', async () => {
    enqueue(TOKENS, enlace());
    enqueue('perfiles', PENDIENTE, FALLO);

    await expect(verifyEmail('a'.repeat(64))).rejects.toMatchObject({ statusCode: 500 });
    expect(escrituras()).toEqual(['auth', 'perfiles']);
  });

  it('si no se puede marcar el enlace como usado: error (reintentar ya no cambia la cuenta)', async () => {
    enqueue(TOKENS, enlace(), FALLO);
    enqueue('perfiles', PENDIENTE);

    await expect(verifyEmail('a'.repeat(64))).rejects.toMatchObject({ statusCode: 500 });
    expect(escrituras()).toEqual(['auth', 'perfiles', TOKENS]);
  });

  it('si no se puede leer el perfil: error y nada escrito', async () => {
    enqueue(TOKENS, enlace());
    enqueue('perfiles', { data: null, error: { message: 'connection reset' } });

    await expect(verifyEmail('a'.repeat(64))).rejects.toMatchObject({ statusCode: 500 });
    expect(escrituras()).toEqual([]);
  });

  // Un segundo enlace que siga vigente no reactiva una cuenta ya verificada
  // (pudo desactivarla un administrador), ni una que no sea un autorregistro.
  it.each([
    ['ya verificada', { registration_source: 'email', email_verified_at: '2026-09-30T10:00:00Z' }],
    ['creada por un administrador', { registration_source: 'admin', email_verified_at: null }],
  ])('cuenta %s: gasta el enlace sin tocar la cuenta', async (_caso, estado) => {
    enqueue(TOKENS, enlace());
    enqueue('perfiles', { data: estado, error: null });

    await expect(verifyEmail('a'.repeat(64))).resolves.toMatchObject({ message: expect.stringContaining('ya estaba verificado') });
    expect(escrituras()).toEqual([TOKENS]);
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });

  it('enlace desconocido o vencido: 400 y nada escrito', async () => {
    await expect(verifyEmail('a'.repeat(64))).rejects.toMatchObject({ statusCode: 400, errorCode: 'INVALID_VERIFICATION_TOKEN' });

    enqueue(TOKENS, enlace({ expires_at: new Date(Date.now() - 1000).toISOString() }));
    await expect(verifyEmail('a'.repeat(64))).rejects.toMatchObject({ statusCode: 400, errorCode: 'INVALID_VERIFICATION_TOKEN' });
    expect(escrituras()).toEqual([]);
  });

  it('enlace ya usado: éxito si la cuenta quedó verificada (doble clic), 400 si no', async () => {
    enqueue(TOKENS, enlace({ used_at: '2026-09-30T10:00:00Z' }));
    enqueue('perfiles', { data: { email_verified_at: '2026-09-30T10:00:00Z' }, error: null });
    await expect(verifyEmail('a'.repeat(64))).resolves.toMatchObject({ message: expect.stringContaining('ya estaba verificado') });

    enqueue(TOKENS, enlace({ used_at: '2026-09-30T10:00:00Z' }));
    enqueue('perfiles', { data: { email_verified_at: null }, error: null });
    await expect(verifyEmail('a'.repeat(64))).rejects.toMatchObject({ statusCode: 400, errorCode: 'INVALID_VERIFICATION_TOKEN' });
    expect(escrituras()).toEqual([]);
  });
});
