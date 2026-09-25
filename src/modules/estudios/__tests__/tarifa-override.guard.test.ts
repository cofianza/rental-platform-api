import { describe, it, expect, vi, beforeEach } from 'vitest';

// P35: la tarifa especial se pone en el estudio del titular y antes de firmar.
// Firmado el contrato va en un otrosí; en firma, se cancela el envío y se
// regenera. Mock de Supabase con colas por tabla, como pago-estudio.

const { mockFrom, ops, queues, enqueue } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'update', 'eq', 'neq', 'in', 'order', 'limit'];
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
    mockFrom: vi.fn((table: string) => chainFor(table)),
    ops,
    queues,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t) } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/lib/tenantScope', () => ({ assertExpedienteAccess: vi.fn(async () => undefined) }));
vi.mock('@/lib/calibracion', () => ({ getCalibracion: vi.fn(async () => ({ TARIFA_IVA: 19 })) }));
// Adenda 1 §5: solo la Gerencia General (GERENCIA_GENERAL_EMAILS).
vi.mock('@/lib/gerenciaGeneral', () => ({
  esGerenciaGeneral: (u: { rol: string; email: string }) => u.rol === 'administrador' && u.email === 'gg@cofianza.co',
}));
vi.mock('../certificado.service', () => ({
  generarCertificado: vi.fn(),
  viaDelEstudio: vi.fn(async () => 'automatica'),
}));
vi.mock('../coarrendatario-vinculado', () => ({
  coarrendatarioVinculado: vi.fn(async () => null),
  coarrendatarioVinculadoVerificado: vi.fn(async () => null),
  assertNoEsEstudioDeOtraPersona: vi.fn(),
}));

import { setTarifaOverride, quitarTarifaOverride } from '../tarifa-override.service';

const override = { autorizado_por: 'admin-1', autorizado_en: '2026-09-20T00:00:00Z', tarifa_mensual_pct: 1.5 };
const fila = (tipo = 'individual', tarifa_override: unknown = null) => ({
  data: {
    id: 'est-1', expediente_id: 'exp-1', tipo, estado: 'completado', resultado: 'aprobado',
    referencia_proveedor: 'ref', cascada: null, canon_evaluado: 2000000, tarifa_override,
    certificado_url: null, expedientes: { inmuebles: { valor_arriendo: 2000000 } },
  },
  error: null,
});
const contratos = (...estados: string[]) => enqueue('contratos', { data: estados.map((estado) => ({ estado })), error: null });
const input = { tarifa_mensual_pct: 1.5, motivo: 'Negociado con Gerencia' };
const guardoEnEstudio = () => ops.some((o) => o.table === 'estudios' && o.method === 'update');

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
});

describe('tarifa especial (P35)', () => {
  it('en el estudio del co-arrendatario: 409 TARIFA_SOLO_TITULAR', async () => {
    enqueue('estudios', fila('con_coarrendatario'));

    await expect(setTarifaOverride('est-1', input, 'admin-1', 'administrador', 'gg@cofianza.co')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'TARIFA_SOLO_TITULAR',
    });
    expect(guardoEnEstudio()).toBe(false);
  });

  it.each(['firmado', 'vigente'])('con el contrato %s: se formaliza con un otrosí', async (estado) => {
    enqueue('estudios', fila());
    contratos(estado);

    await expect(setTarifaOverride('est-1', input, 'admin-1', 'administrador', 'gg@cofianza.co')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'TARIFA_CONTRATO_FIRMADO',
      message: expect.stringContaining('otrosí firmado por las partes'),
    });
    expect(guardoEnEstudio()).toBe(false);
  });

  it('con el contrato en firma: cancelar el envío y regenerar', async () => {
    enqueue('estudios', fila());
    contratos('pendiente_firma');

    await expect(setTarifaOverride('est-1', input, 'admin-1', 'administrador', 'gg@cofianza.co')).rejects.toMatchObject({
      errorCode: 'TARIFA_CONTRATO_EN_FIRMA',
      message: expect.stringContaining('cancela el envío a firma'),
    });
  });

  it('quitarla tampoco se puede con el contrato firmado', async () => {
    enqueue('estudios', fila('individual', override));
    contratos('vigente');

    await expect(quitarTarifaOverride('est-1', 'admin-1', 'administrador', 'gg@cofianza.co')).rejects.toMatchObject({
      errorCode: 'TARIFA_CONTRATO_FIRMADO',
    });
    expect(guardoEnEstudio()).toBe(false);
  });

  it('sin contrato en firma ni firmado: se guarda en el estudio del titular', async () => {
    enqueue('estudios', fila(), { data: null, error: null }, fila('individual', override));
    contratos();

    const r = await setTarifaOverride('est-1', input, 'admin-1', 'administrador', 'gg@cofianza.co');

    expect(guardoEnEstudio()).toBe(true);
    expect(r.tarifas.tarifa_mensual_pct).toBe(1.5);
    expect(ops.find((o) => o.table === 'contratos' && o.method === 'in')?.args[1]).toEqual(
      expect.arrayContaining(['pendiente_firma', 'firmado', 'vigente']),
    );
  });

  it('otro administrador (no Gerencia General): 403 SOLO_GERENCIA_GENERAL al poner y al quitar', async () => {
    await expect(setTarifaOverride('est-1', input, 'admin-2', 'administrador', 'otro@cofianza.co')).rejects.toMatchObject({
      statusCode: 403,
      errorCode: 'SOLO_GERENCIA_GENERAL',
    });
    await expect(quitarTarifaOverride('est-1', 'admin-2', 'administrador', 'otro@cofianza.co')).rejects.toMatchObject({
      statusCode: 403,
      errorCode: 'SOLO_GERENCIA_GENERAL',
    });
    expect(ops.length).toBe(0);
  });
});
