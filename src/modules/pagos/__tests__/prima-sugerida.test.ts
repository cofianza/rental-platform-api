import { describe, it, expect, vi, beforeEach } from 'vitest';
import { calcularTarifas } from '@/modules/estudios/tarifas';

// La garantía es la prima de vinculación: el modal de cobro la sugiere con IVA
// (Adenda 1 de contratos §1.1), sobre el canon pactado si ya hay contrato
// (respuesta 9) y si no sobre el evaluado. Mock de Supabase con colas por tabla.

const { mockFrom, ops, queues, enqueue, mockTarifasParaContrato } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const PASSTHROUGH = ['select', 'eq', 'neq', 'in', 'not', 'order', 'limit'];
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of PASSTHROUGH) {
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
    queues,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    mockTarifasParaContrato: vi.fn(),
  };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => mockFrom(t) } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/config', () => ({ env: { FRONTEND_URL: 'http://localhost:3000' } }));
vi.mock('@/lib/email', () => ({ sendPaymentLinkEmail: vi.fn() }));
vi.mock('@/lib/tenantScope', () => ({ assertExpedienteAccess: vi.fn(async () => undefined) }));
vi.mock('@/modules/estudios/tope-canon.guard', () => ({ assertCanonDentroDelTope: vi.fn() }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({ notificarYCorreo: vi.fn() }));
vi.mock('../gateway', () => ({ getPaymentGateway: () => ({ provider: 'mercadopago' }) }));
vi.mock('@/modules/contratos/contratos.service', () => ({ tarifasParaContrato: mockTarifasParaContrato }));

import { getPrimaSugerida } from '../pagos.service';

const EXP = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
  // Estudio aprobado automático, firma solo, evaluado con canon 1.500.000.
  mockTarifasParaContrato.mockResolvedValue(
    calcularTarifas({ via: 'automatica', conCoarrendatario: false, canonCop: 1_500_000, ivaPct: 19 }),
  );
});

describe('getPrimaSugerida', () => {
  it('con contrato: 20 % del canon pactado (1.600.000) = 320.000 + IVA = 380.800', async () => {
    enqueue('contratos', { data: { valor_arriendo: '1600000.00' }, error: null });

    expect(await getPrimaSugerida(EXP, 'op-1', 'operador_analista')).toEqual({
      canon: 'contrato',
      prima_vinculacion_pct: 20,
      prima_vinculacion_cop: 320_000,
      iva_pct: 19,
      prima_vinculacion_con_iva_cop: 380_800,
      sin_sugerencia: null,
    });
    expect(ops).toContainEqual({ table: 'contratos', method: 'neq', args: ['estado', 'cancelado'] });
  });

  it('sin contrato: sobre el canon evaluado, 300.000 + IVA = 357.000', async () => {
    const r = await getPrimaSugerida(EXP, 'op-1', 'operador_analista');

    expect(r.canon).toBe('estudio');
    expect(r.prima_vinculacion_cop).toBe(300_000);
    expect(r.prima_vinculacion_con_iva_cop).toBe(357_000);
  });

  it('si no se pudo leer el coarrendatario no sugiere nada (la prima sería 10 %, no 20 %) y dice por qué', async () => {
    enqueue('expediente_coarrendatarios', { data: null, error: { message: 'timeout' } });

    const r = await getPrimaSugerida(EXP, 'op-1', 'operador_analista');

    expect(r.prima_vinculacion_con_iva_cop).toBeNull();
    expect(r.prima_vinculacion_pct).toBeNull();
    expect(r.sin_sugerencia).toMatch(/coarrendatario/);
  });

  it('la tarifa dice «solo» pero hay coarrendatario vinculado: tampoco sugiere', async () => {
    enqueue('expediente_coarrendatarios', { data: { id: 'coa-1', nombre: 'Luis', estudio_id: 'est-coa' }, error: null });
    enqueue('estudios', { data: { estado: 'completado', resultado: 'condicionado' }, error: null });

    expect((await getPrimaSugerida(EXP, 'op-1', 'operador_analista')).sin_sugerencia).toMatch(/coarrendatario/);
  });

  // P2 (2026-09-24): un coarrendatario con la evaluación rechazada no cuenta, y la
  // relectura estricta coincide con la tarifa («solo»): sugiere el 20 %.
  it('coarrendatario aceptado con la evaluación rechazada: sugiere el 20 %', async () => {
    enqueue('expediente_coarrendatarios', { data: { id: 'coa-1', nombre: 'Luis', estudio_id: 'est-coa' }, error: null });
    enqueue('estudios', { data: { estado: 'completado', resultado: 'rechazado' }, error: null });

    const r = await getPrimaSugerida(EXP, 'op-1', 'operador_analista');

    expect(r.sin_sugerencia).toBeNull();
    expect(r.prima_vinculacion_pct).toBe(20);
  });

  it('con un contrato ya generado sin él manda el contrato: 20 % aunque su evaluación terminó bien', async () => {
    enqueue(
      'contratos',
      { data: { valor_arriendo: '1600000.00' }, error: null },
      { data: [{ id: 'c1', estado: 'vigente', destinacion: null, coa_anidado: null, coa_plano: '' }], error: null },
    );
    enqueue('expediente_coarrendatarios', { data: { id: 'coa-1', nombre: 'Luis', estudio_id: 'est-coa' }, error: null });
    enqueue('estudios', { data: { estado: 'completado', resultado: 'aprobado' }, error: null });

    const r = await getPrimaSugerida(EXP, 'op-1', 'operador_analista');

    expect(r.sin_sugerencia).toBeNull();
    expect(r.prima_vinculacion_pct).toBe(20);
  });

  it('con la prima negociada por Gerencia el coarrendatario no importa', async () => {
    mockTarifasParaContrato.mockResolvedValue(
      calcularTarifas({
        via: 'automatica',
        conCoarrendatario: false,
        canonCop: 1_500_000,
        ivaPct: 19,
        override: { prima_vinculacion_pct: 15, autorizado_por: 'g', autorizado_en: '2026-09-23T00:00:00Z' },
      }),
    );
    enqueue('expediente_coarrendatarios', { data: null, error: { message: 'timeout' } });

    const r = await getPrimaSugerida(EXP, 'op-1', 'operador_analista');

    expect(r.sin_sugerencia).toBeNull();
    expect(r.prima_vinculacion_con_iva_cop).toBe(267_750); // 15 % de 1.500.000 = 225.000 + IVA
  });
});
