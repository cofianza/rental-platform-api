import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Expiración del estudio (§12) anclada al vencimiento guardado del enlace: si
// Gerencia cambia DIAS_EXPIRACION_ESTUDIO, los enlaces ya enviados conservan su
// fecha y el estudio vence con ellos, no con el plazo nuevo.
// ============================================================

const { mockEnv, ops, queues, enqueue, mockFrom } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null, count: null };
  };
  const PASSTHROUGH = ['select', 'eq', 'neq', 'is', 'in', 'or', 'gte', 'order', 'limit', 'range'];
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of PASSTHROUGH) {
      chain[m] = (...args: unknown[]) => {
        ops.push({ table, method: m, args });
        return chain;
      };
    }
    chain.maybeSingle = async () => next(table);
    chain.single = async () => next(table);
    chain.then = (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next(table)).then(resolve, reject);
    return chain;
  };
  return {
    // Flags *_ENABLED / MOTOR_* apagados; lo demas un string.
    mockEnv: new Proxy({} as Record<string, unknown>, {
      get: (_t, k) => (typeof k === 'string' && (k.endsWith('_ENABLED') || k.startsWith('MOTOR_')) ? false : 'x'),
    }),
    ops,
    queues,
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
vi.mock('@/lib/calibracion', () => ({ getCalibracion: vi.fn(async () => ({ DIAS_EXPIRACION_ESTUDIO: 30 })) }));
vi.mock('@/lib/tenantScope', () => ({
  resolveAllowedExpedienteIds: vi.fn(),
  perfilEsDuenoDeInmueble: vi.fn(),
  assertExpedienteAccess: vi.fn(async () => undefined),
}));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({
  notificarUsuario: vi.fn(),
  findPerfilIdByEmail: vi.fn(),
  notificarResponsableExpediente: vi.fn(),
}));
vi.mock('@/modules/whatsapp', () => ({ enviarTemplate: vi.fn() }));

import { getEstudioById } from '../estudios.service';

const DIA = 86_400_000;
const estudio = { id: 'est-1', expediente_id: 'exp-1', tipo: 'individual', estado: 'solicitado', resultado: null };
const autorizacion = (enviadaHaceDias: number, plazoEnlaceDias: number | null) => {
  const creada = Date.now() - enviadaHaceDias * DIA;
  return {
    created_at: new Date(creada).toISOString(),
    estado: 'pendiente',
    token_expiracion: plazoEnlaceDias == null ? null : new Date(creada + plazoEnlaceDias * DIA).toISOString(),
  };
};
const expiracionDe = async () =>
  ((await getEstudioById('est-1', 'u-1', 'operador_analista')) as { expiracion: { expirado: boolean; motivo: string } })
    .expiracion;

beforeEach(() => {
  queues.clear();
  ops.length = 0;
});

describe('expiración del estudio y vencimiento del enlace', () => {
  it('subir el plazo (a 30) no revive un estudio cuyo enlace de 15 días ya murió', async () => {
    enqueue('estudios', { data: estudio, error: null });
    enqueue('autorizaciones_habeas_data', { data: autorizacion(20, 15), error: null });
    const exp = await expiracionDe();
    expect(exp.expirado).toBe(true);
    expect(exp.motivo).toContain('15 dias');
  });

  it('bajar el plazo no expira un estudio con el enlace todavía vivo', async () => {
    enqueue('estudios', { data: estudio, error: null });
    enqueue('autorizaciones_habeas_data', { data: autorizacion(35, 40), error: null });
    expect((await expiracionDe()).expirado).toBe(false);
  });

  it('sin vencimiento guardado usa el plazo de calibración vigente (30)', async () => {
    enqueue('estudios', { data: estudio, error: null });
    enqueue('autorizaciones_habeas_data', { data: autorizacion(20, null), error: null });
    expect((await expiracionDe()).expirado).toBe(false);
  });
});
