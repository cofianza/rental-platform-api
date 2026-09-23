import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Politica §8: 15 dias habiles para re-evaluar. solicitarReEvaluacion ya lo
// validaba, pero el historial seguia diciendo `puede_reevaluar: true` y la
// URL de subida de soportes se firmaba igual: el gestor subia documentos y el
// 400 llegaba al final. Mock de Supabase con colas por tabla.
// ============================================================

const { mockEnv, queues, enqueue, mockFrom, mockStorageFrom } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null, count: null };
  };
  const PASSTHROUGH = ['select', 'eq', 'neq', 'is', 'in', 'or', 'gte', 'order', 'limit', 'range'];
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of PASSTHROUGH) chain[m] = () => chain;
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
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    mockFrom: vi.fn((table: string) => chainFor(table)),
    mockStorageFrom: vi.fn(() => ({
      createSignedUploadUrl: vi.fn(async () => ({ data: { signedUrl: 'https://up', token: 't' }, error: null })),
    })),
  };
});

vi.mock('@/config', () => ({ env: mockEnv }));
vi.mock('@/config/env', () => ({ env: mockEnv }));
vi.mock('@/lib/supabase', () => ({
  supabase: { from: (t: string) => mockFrom(t), rpc: vi.fn(), storage: { from: mockStorageFrom } },
}));
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
  perfilEsDuenoDeInmueble: vi.fn(),
  assertExpedienteAccess: vi.fn(async () => undefined),
}));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({
  notificarUsuario: vi.fn(),
  findPerfilIdByEmail: vi.fn(),
  notificarResponsableExpediente: vi.fn(),
}));
vi.mock('@/modules/whatsapp', () => ({ enviarTemplate: vi.fn() }));

import { getHistorialReEvaluacion, getSoportePresignedUrl } from '../estudios.service';

const hace = (dias: number) => new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();

const rechazado = (fechaCompletado: string) => ({
  id: 'est-1',
  expediente_id: 'exp-1',
  tipo: 'individual',
  estado: 'completado',
  resultado: 'rechazado',
  estudio_padre_id: null,
  fecha_completado: fechaCompletado,
});

function encolarHistorial(fechaCompletado: string) {
  enqueue(
    'estudios',
    { data: { expediente_id: 'exp-1', tipo: 'individual' }, error: null }, // guard
    { data: { id: 'est-1', estudio_padre_id: null }, error: null }, // raiz
    { data: [rechazado(fechaCompletado)], error: null }, // cadena
  );
  enqueue('estudios_documentos_soporte', { data: [], error: null });
}

beforeEach(() => {
  queues.clear();
  mockStorageFrom.mockClear();
});

describe('plazo de re-evaluacion (Politica §8)', () => {
  it('rechazado hace 40 dias corridos: el historial ya no ofrece re-evaluar', async () => {
    encolarHistorial(hace(40));
    const h = await getHistorialReEvaluacion('est-1', 'u-1', 'operador_analista');
    expect(h.puede_reevaluar).toBe(false);
    expect(h.plazo_vencido).toBe(true);
  });

  it('rechazado ayer: sigue dentro del plazo', async () => {
    encolarHistorial(hace(1));
    const h = await getHistorialReEvaluacion('est-1', 'u-1', 'operador_analista');
    expect(h.puede_reevaluar).toBe(true);
    expect(h.plazo_vencido).toBe(false);
  });

  it('fuera del plazo no se firma la URL de subida de soportes', async () => {
    enqueue('estudios', { data: rechazado(hace(40)), error: null });
    await expect(
      getSoportePresignedUrl(
        'est-1',
        { nombre_original: 'a.pdf', tipo_mime: 'application/pdf', tamano_bytes: 10, proposito: 'otros_soportes' } as never,
        'u-1',
        'operador_analista',
      ),
    ).rejects.toMatchObject({ statusCode: 400, errorCode: 'REEVALUACION_FUERA_DE_PLAZO' });
    expect(mockStorageFrom).not.toHaveBeenCalled();
  });
});
