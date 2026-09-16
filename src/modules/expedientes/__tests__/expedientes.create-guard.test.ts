/**
 * Guard de cartera al CREAR un expediente.
 *
 * Faltaba: createExpediente solo validaba que el inmueble existiera. Como el
 * expediente hereda `inmobiliaria_id` del inmueble, crear sobre una propiedad
 * ajena metia una ficha en la cartera de otra agencia —invisible para quien la
 * creo, pero capaz de reservarle el inmueble— y los mensajes distintos ('no
 * encontrado' / 'reservado' / 'ocupado') confirmaban de paso la existencia y el
 * estado de un inmueble ajeno.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFrom, mockAssertInmueble } = vi.hoisted(() => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'insert', 'update', 'eq', 'in', 'or', 'not', 'order', 'limit', 'maybeSingle']) {
    chain[m] = () => chain;
  }
  chain.single = async () => ({ data: null, error: { message: 'no deberia consultarse' } });
  chain.maybeSingle = async () => ({ data: null, error: null });
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve);
  return {
    mockFrom: vi.fn(() => chain),
    mockAssertInmueble: vi.fn(async () => undefined),
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t) } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/config', () => ({ env: { FRONTEND_URL: 'http://localhost:3000' } }));
vi.mock('@/config/env', () => ({ env: { FRONTEND_URL: 'http://localhost:3000', RESEND_API_KEY: 'x' } }));
vi.mock('@/lib/tenantScope', () => ({
  assertInmuebleAccess: (...a: unknown[]) => mockAssertInmueble(...(a as [])),
  assertExpedienteAccess: vi.fn(async () => undefined),
  resolveOrgMemberPerfilIds: vi.fn(async () => []),
  resolveAllowedInmuebleIds: vi.fn(async () => null),
  esMiembroNoOwnerDeOrg: vi.fn(async () => false),
  resolveVisibilityScope: vi.fn(async () => ({ kind: 'all' })),
  perfilEsDuenoDeInmueble: vi.fn(async () => true),
}));

import { createExpediente } from '../expedientes.service';

const INMUEBLE_AJENO = '22222222-2222-2222-2222-222222222222';

describe('createExpediente — guard de cartera', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pide el guard del inmueble ANTES de tocar la base', async () => {
    mockAssertInmueble.mockRejectedValueOnce(
      Object.assign(new Error('Inmueble no encontrado'), { errorCode: 'INMUEBLE_NOT_FOUND' }),
    );

    await expect(
      createExpediente(
        { inmueble_id: INMUEBLE_AJENO, solicitante_id: 'sol-1' } as never,
        'propietario-de-otra-cartera',
        undefined,
        'propietario',
      ),
    ).rejects.toThrow('Inmueble no encontrado');

    expect(mockAssertInmueble).toHaveBeenCalledWith(INMUEBLE_AJENO, 'propietario-de-otra-cartera', 'propietario');
    // Si el guard salta primero, el inmueble ajeno ni se consulta: sin esto los
    // mensajes distintos ya delataban su existencia y su estado.
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('el rol viaja hasta el guard (sin el, todo caller seria un rol interno)', async () => {
    await createExpediente(
      { inmueble_id: INMUEBLE_AJENO, solicitante_id: 'sol-1' } as never,
      'user-1',
      undefined,
      'inmobiliaria',
    ).catch(() => { /* falla despues, en la consulta; aqui solo importa el guard */ });

    expect(mockAssertInmueble).toHaveBeenCalledWith(INMUEBLE_AJENO, 'user-1', 'inmobiliaria');
  });
});
