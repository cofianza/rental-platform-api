/**
 * Crear un estudio con el solicitante de OTRA agencia.
 *
 * createExpediente y createEstudioFromInmueble (RPC) solo comprobaban que el
 * solicitante existiera: con el UUID de un cliente ajeno, el estudio nacia en
 * la cartera propia con su documento, correo y telefono, y le llegaba el habeas
 * data a nombre de una agencia desconocida. Ahora pasan por getApplicantById,
 * que aplica el mismo scope que la lista y el detalle de solicitantes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queues, ops, mockRpc, mockGetApplicant } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string }> = [];
  return {
    queues,
    ops,
    mockRpc: vi.fn(async () => ({ data: null, error: null })),
    mockGetApplicant: vi.fn(),
  };
});

vi.mock('@/lib/supabase', () => {
  const chainFor = (table: string) => {
    const next = async () => queues.get(table)?.shift() ?? { data: null, error: null };
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'update', 'eq', 'neq', 'in', 'or', 'not', 'order', 'limit']) {
      chain[m] = () => {
        ops.push({ table, method: m });
        return chain;
      };
    }
    chain.single = next;
    chain.maybeSingle = next;
    chain.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => next().then(ok, ko);
    return chain;
  };
  return { supabase: { from: (t: string) => chainFor(t), rpc: mockRpc, storage: { from: vi.fn() } } };
});

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: new Proxy({} as Record<string, unknown>, {
    get: (_t, k) => (typeof k === 'string' && k.endsWith('_ENABLED') ? false : 'x'),
  }),
}));
vi.mock('@/config', () => ({ env: mockEnv }));
vi.mock('@/config/env', () => ({ env: mockEnv }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({
  logAudit: vi.fn(),
  AUDIT_ACTIONS: new Proxy({}, { get: (_t, k) => String(k) }),
  AUDIT_ENTITIES: new Proxy({}, { get: (_t, k) => String(k) }),
}));
vi.mock('@/lib/email', () => ({ sendEstudioFormEmail: vi.fn() }));
vi.mock('@/lib/calibracion', () => ({ getCalibracion: vi.fn(async () => ({})) }));
vi.mock('@/lib/tenantScope', () => ({
  assertInmuebleAccess: vi.fn(async () => undefined),
  assertExpedienteAccess: vi.fn(async () => undefined),
  perfilEsDuenoDeInmueble: vi.fn(async () => true),
  resolveAllowedExpedienteIds: vi.fn(async () => null),
  resolveAllowedInmuebleIds: vi.fn(async () => null),
  resolveOrgMemberPerfilIds: vi.fn(async () => []),
}));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({
  notificarUsuario: vi.fn(),
  notificarYCorreo: vi.fn(),
  findPerfilIdByEmail: vi.fn(),
  notificarResponsableExpediente: vi.fn(),
}));
vi.mock('@/modules/whatsapp', () => ({ enviarTemplate: vi.fn() }));
vi.mock('@/modules/estudios/tope-canon.guard', () => ({
  assertCanonDentroDelTope: vi.fn(async () => undefined),
  leerCanonDelInmueble: vi.fn(),
}));
vi.mock('@/modules/solicitantes/solicitantes.service', () => ({
  getApplicantById: (...a: unknown[]) => mockGetApplicant(...a),
}));

import { createExpediente } from '../expedientes.service';
import { createEstudioFromInmueble } from '@/modules/estudios/estudios.service';

const INMUEBLE = '22222222-2222-2222-2222-222222222222';
const AJENO = '33333333-3333-3333-3333-333333333333';
const noEncontrado = Object.assign(new Error('Solicitante no encontrado'), { statusCode: 404, errorCode: 'NOT_FOUND' });

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
  mockGetApplicant.mockRejectedValue(noEncontrado);
});

describe('solicitante de otra agencia al crear el estudio', () => {
  it('createExpediente: 404 y el expediente no se inserta', async () => {
    queues.set('inmuebles', [{ data: { id: INMUEBLE, codigo: 'INM-1', estado: 'disponible', inmobiliaria_id: 'org-b', reservado_por_expediente_id: null }, error: null }]);

    await expect(
      createExpediente({ inmueble_id: INMUEBLE, solicitante_id: AJENO } as never, 'user-b', undefined, 'inmobiliaria'),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(mockGetApplicant).toHaveBeenCalledWith(AJENO, 'user-b', 'inmobiliaria');
    expect(ops.some((o) => o.table === 'expedientes' && o.method === 'insert')).toBe(false);
  });

  it('createEstudioFromInmueble: 404 antes de llamar al RPC', async () => {
    queues.set('inmuebles', [{ data: { propietario_id: null, inmobiliaria_id: 'org-b' }, error: null }]);

    await expect(
      createEstudioFromInmueble(INMUEBLE, { solicitante_id: AJENO } as never, 'user-b', undefined, 'inmobiliaria'),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(mockGetApplicant).toHaveBeenCalledWith(AJENO, 'user-b', 'inmobiliaria');
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
