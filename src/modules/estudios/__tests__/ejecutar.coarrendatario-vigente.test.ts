import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// P3 (revisión 2026-09-24): la evaluación del co-arrendatario solo se ejecuta
// con el estudio en revisión (condicionado). Decidido el caso, reintentarla
// consultaría el buró de un tercero sin finalidad. Mock de Supabase con colas
// por tabla (patrón de reevaluacion.plazo.test).
// ============================================================

const { mockEnv, queues, enqueue, ops, mockFrom } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null, count: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'update', 'eq', 'neq', 'is', 'in', 'or', 'gte', 'order', 'limit', 'range'];
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of PASSTHROUGH)
      chain[m] = () => {
        ops.push({ table, method: m });
        return chain;
      };
    chain.maybeSingle = async () => next(table);
    chain.single = async () => next(table);
    chain.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  return {
    mockEnv: new Proxy({} as Record<string, unknown>, {
      get: (_t, k) => (typeof k === 'string' && (k.endsWith('_ENABLED') || k.startsWith('MOTOR_')) ? false : 'x'),
    }),
    queues,
    ops,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    mockFrom: vi.fn((table: string) => chainFor(table)),
  };
});

vi.mock('@/config', () => ({ env: mockEnv }));
vi.mock('@/config/env', () => ({ env: mockEnv }));
vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t), rpc: vi.fn(), storage: { from: vi.fn() } } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({
  logAudit: vi.fn(),
  AUDIT_ACTIONS: new Proxy({}, { get: (_t, k) => String(k) }),
  AUDIT_ENTITIES: new Proxy({}, { get: (_t, k) => String(k) }),
}));
vi.mock('@/lib/email', () => ({ sendEstudioFormEmail: vi.fn() }));
vi.mock('@/lib/calibracion', () => ({ getCalibracion: vi.fn(async () => ({})) }));
vi.mock('@/lib/tenantScope', () => ({
  resolveAllowedExpedienteIds: vi.fn(),
  perfilEsDuenoDeInmueble: vi.fn(async () => true),
  assertExpedienteAccess: vi.fn(async () => undefined),
}));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({
  notificarUsuario: vi.fn(),
  findPerfilIdByEmail: vi.fn(),
  notificarResponsableExpediente: vi.fn(),
}));
vi.mock('@/modules/whatsapp', () => ({ enviarTemplate: vi.fn() }));

import { ejecutarEstudio } from '../estudios.service';

const estudioCoa = {
  data: {
    id: 'est-coa',
    estado: 'fallido',
    resultado: 'pendiente',
    score: null,
    proveedor: 'transunion',
    tipo: 'con_coarrendatario',
    datos_formulario: { numero_documento: '7654321' },
    expediente_id: 'exp-1',
  },
  error: null,
};
const expedienteHabilitado = {
  data: { id: 'exp-1', numero: 'EXP-2026-0001', estudio_habilitado: true, solicitante_id: 'sol-1', inmueble_id: 'inm-1' },
  error: null,
};

beforeEach(() => {
  queues.clear();
  ops.length = 0;
});

describe('ejecutarEstudio — evaluación del co-arrendatario', () => {
  it.each(['aprobado', 'rechazado', 'cerrado'])('con el estudio %s: 409 y no sigue al tope ni al buró', async (estado) => {
    enqueue('estudios', estudioCoa);
    enqueue('expedientes', expedienteHabilitado, { data: { estado }, error: null });

    await expect(ejecutarEstudio('est-coa', 'admin-1', '1.1.1.1', 'administrador')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'COARRENDATARIO_ESTUDIO_NO_VIGENTE',
    });
    expect(ops.some((o) => o.table === 'inmuebles' || o.method === 'update')).toBe(false);
  });

  it('con el estudio condicionado este guard lo deja seguir', async () => {
    enqueue('estudios', estudioCoa);
    enqueue('expedientes', expedienteHabilitado, { data: { estado: 'condicionado' }, error: null });

    const e = await ejecutarEstudio('est-coa', 'admin-1', '1.1.1.1', 'administrador').catch((x: unknown) => x);

    expect((e as { errorCode?: string } | undefined)?.errorCode).not.toBe('COARRENDATARIO_ESTUDIO_NO_VIGENTE');
  });
});
