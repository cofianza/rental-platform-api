import { describe, it, expect, vi, beforeEach } from 'vitest';

// Ley 820 de 2003 art. 16 (Técnico V3 §2.5): en vivienda no se cobra depósito.
// Ni por link de pasarela, ni a mano, ni reenviando un link viejo.

const { mockFrom, ops, queues, enqueue } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'in', 'not', 'order', 'limit'];
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
vi.mock('@/config', () => ({ env: { FRONTEND_URL: 'http://localhost:3000' } }));
vi.mock('@/lib/email', () => ({ sendPaymentLinkEmail: vi.fn() }));
vi.mock('@/lib/tenantScope', () => ({ assertExpedienteAccess: vi.fn(async () => undefined) }));
vi.mock('@/modules/estudios/tope-canon.guard', () => ({ assertCanonDentroDelTope: vi.fn() }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({
  notificarUsuario: vi.fn(async () => undefined),
  notificarYCorreo: vi.fn(async () => undefined),
  findPerfilIdByEmail: vi.fn(async () => null),
  notificarResponsableExpediente: vi.fn(async () => undefined),
}));
vi.mock('../gateway', () => ({ getPaymentGateway: () => ({ provider: 'mercadopago' }) }));

import { createPaymentLink, registerManualPayment, resendPaymentLink } from '../pagos.service';

const EXP = '11111111-1111-1111-1111-111111111111';
const manual = { concepto: 'deposito', monto: 1500000, metodo: 'transferencia', fecha_pago: '2026-09-01' } as Parameters<
  typeof registerManualPayment
>[1];
const link = {
  concepto: 'deposito', monto: 1500000, descripcion: 'Depósito', email_pagador: 'a@b.co', nombre_pagador: 'Ana', enviar_email: false,
} as Parameters<typeof createPaymentLink>[1];

const usoDelInmueble = (uso: string | null) => ({ data: { inmuebles: uso === null ? null : { uso } }, error: null });
const tocoPagos = () => ops.some((o) => o.table === 'pagos' && (o.method === 'insert' || o.method === 'update'));

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
});

describe('depósito de garantía', () => {
  it.each(['vivienda', 'mixto', null])('inmueble %s: el pago manual se rechaza sin registrar nada', async (uso) => {
    enqueue('expedientes', { data: { id: EXP, estado: 'aprobado' }, error: null }, usoDelInmueble(uso));

    await expect(registerManualPayment(EXP, manual, 'op-1', 'operador_analista')).rejects.toMatchObject({
      statusCode: 400,
      errorCode: 'DEPOSITO_NO_PERMITIDO_VIVIENDA',
    });
    expect(tocoPagos()).toBe(false);
    // La destinación sale del inmueble del estudio (con el hint de la FK).
    expect(ops.find((o) => o.table === 'expedientes' && o.method === 'select' && String(o.args[0]).includes('uso'))?.args[0]).toBe(
      'inmuebles!expedientes_inmueble_id_fkey(uso)',
    );
  });

  it('vivienda: el link de pasarela se rechaza antes de crear el cobro', async () => {
    enqueue('expedientes', { data: { id: EXP, numero: 'EXP-1', estado: 'aprobado' }, error: null }, usoDelInmueble('vivienda'));

    await expect(createPaymentLink(EXP, link, 'op-1', 'operador_analista')).rejects.toMatchObject({
      errorCode: 'DEPOSITO_NO_PERMITIDO_VIVIENDA',
    });
    expect(tocoPagos()).toBe(false);
  });

  it('vivienda: un link de depósito viejo tampoco se reenvía', async () => {
    enqueue('pagos', {
      data: { id: 'p1', estado: 'pendiente', concepto: 'deposito', expediente_id: EXP, payment_link_url: 'https://mp', email_pagador: 'a@b.co' },
      error: null,
    });
    enqueue('expedientes', usoDelInmueble('vivienda'));

    await expect(resendPaymentLink('p1', 'op-1', 'operador_analista')).rejects.toMatchObject({
      errorCode: 'DEPOSITO_NO_PERMITIDO_VIVIENDA',
    });
  });

  it('comercial: el pago manual se registra', async () => {
    enqueue('expedientes', { data: { id: EXP, estado: 'aprobado' }, error: null }, usoDelInmueble('local_comercial'));
    enqueue('pagos', { data: [], error: null }, { data: { id: 'nuevo', estado: 'completado' }, error: null });

    await expect(registerManualPayment(EXP, manual, 'op-1', 'operador_analista')).resolves.toMatchObject({ id: 'nuevo' });
  });

  it('otro concepto no consulta la destinación', async () => {
    enqueue('expedientes', { data: { id: EXP, estado: 'aprobado' }, error: null });
    enqueue('pagos', { data: [], error: null }, { data: { id: 'nuevo', estado: 'completado' }, error: null });

    await registerManualPayment(EXP, { ...manual, concepto: 'otro' }, 'op-1', 'operador_analista');
    expect(ops.filter((o) => o.table === 'expedientes' && o.method === 'select')).toHaveLength(1);
  });
});
