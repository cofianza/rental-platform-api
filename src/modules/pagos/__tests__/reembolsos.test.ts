import { describe, it, expect, vi, beforeEach } from 'vitest';

// P1: estudio cerrado o rechazado ya pagado y sin consulta al buró → se
// devuelve a quien pagó. El crédito vuelve solo; Mercado Pago queda en la cola
// de reembolsos para que un administrador lo haga («Reembolsar en Mercado
// Pago», idempotente y con registro). El pago que entra después del cierre,
// igual. Mock de Supabase con colas por tabla, como mp-webhook-cancelled.

const {
  mockFrom, ops, queues, enqueue, mockStatus, mockRefund, mockTransitionChecked, mockTransition,
  mockOnPagoConfirmado, mockNotificarYCorreo, mockDevolverCredito,
} = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const ops: Array<{ table: string; method: string; args: unknown[] }> = [];
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'in', 'order', 'limit', 'gte', 'lte'];
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
    mockStatus: vi.fn(),
    mockRefund: vi.fn(),
    mockTransitionChecked: vi.fn(async () => ({ pago: null, transitioned: true })),
    mockTransition: vi.fn(async () => undefined),
    mockOnPagoConfirmado: vi.fn(async () => undefined),
    mockNotificarYCorreo: vi.fn(async () => undefined),
    mockDevolverCredito: vi.fn(async () => 'no_es_credito'),
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
  notificarYCorreo: mockNotificarYCorreo,
  findPerfilIdByEmail: vi.fn(async () => null),
  notificarResponsableExpediente: vi.fn(async () => undefined),
}));
vi.mock('@/modules/orchestrator/orchestrator.service', () => ({ onPagoConfirmado: mockOnPagoConfirmado }));
vi.mock('@/modules/creditos-estudios/creditos-estudios.service', () => ({ devolverCreditoDePago: mockDevolverCredito }));
vi.mock('../gateway', () => ({
  getPaymentGateway: () => ({
    provider: 'mercadopago',
    verifyWebhook: () => ({ event: {}, type: 'payment', eventId: 'mp-77' }),
    getPaymentStatus: mockStatus,
    refund: mockRefund,
    cancelPaymentLink: vi.fn(async () => undefined),
  }),
}));
vi.mock('../pago-state-machine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pago-state-machine')>()),
  transitionPagoStateChecked: mockTransitionChecked,
  transitionPagoState: mockTransition,
}));

import { processWebhookEvent, createPaymentLink } from '../pagos.service';
import { devolverEvaluacionSinConsulta, reembolsarEnMercadoPago } from '../reembolsos.service';

const EXP = '11111111-1111-1111-1111-111111111111';
const PAGO = '22222222-2222-2222-2222-222222222222';
const FILA = '33333333-3333-3333-3333-333333333333';
const pagoMp = {
  id: PAGO,
  monto: 80000,
  metodo: 'pasarela',
  transaction_ref: 'mp-77',
  gateway_response: { external_reference: `estudio:${EXP}:${PAGO}`, transaction_amount: 80000 },
};
const admins = () => enqueue('perfiles', { data: [{ id: 'admin-1' }], error: null });
const upsertNoConciliado = () => ops.find((o) => o.table === 'pagos_no_conciliados' && o.method === 'upsert')?.args[0];

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
  mockTransitionChecked.mockResolvedValue({ pago: null, transitioned: true });
  mockDevolverCredito.mockResolvedValue('no_es_credito');
});

describe('al cerrar o rechazar el estudio', () => {
  it('cancela los cobros vivos de la evaluación, incluido el fallido (Mercado Pago deja reintentar)', async () => {
    enqueue('pagos', { data: [], error: null }); // cobros vivos
    enqueue('pagos', { data: null, error: null }); // sin pago completado

    await devolverEvaluacionSinConsulta(EXP, 'Estudio cerrado', 'user-1');

    const filtro = ops.find((o) => o.table === 'pagos' && o.method === 'in' && o.args[0] === 'estado');
    expect(filtro?.args[1]).toEqual(['pendiente', 'procesando', 'fallido']);
    expect(mockDevolverCredito).not.toHaveBeenCalled();
  });

  it('pagado con crédito y sin consulta al buró: el crédito vuelve solo al saldo', async () => {
    enqueue('pagos', { data: [], error: null });
    enqueue('pagos', { data: { ...pagoMp, metodo: 'transferencia', transaction_ref: null }, error: null });
    enqueue('estudios', { data: [{ estado: 'formulario_completado', referencia_proveedor: null }], error: null });
    mockDevolverCredito.mockResolvedValueOnce('devuelto');

    await devolverEvaluacionSinConsulta(EXP, 'Estudio cerrado', 'user-1');

    expect(mockDevolverCredito).toHaveBeenCalledWith(PAGO, 'Estudio cerrado', 'user-1');
    expect(ops.some((o) => o.table === 'eventos_timeline' && o.method === 'insert')).toBe(true);
    expect(upsertNoConciliado()).toBeUndefined();
  });

  it('pagado por Mercado Pago y sin consulta: queda como reembolso pendiente y se avisa, sin reembolsar solo', async () => {
    enqueue('pagos', { data: [], error: null });
    enqueue('pagos', { data: pagoMp, error: null });
    enqueue('estudios', { data: [], error: null });
    enqueue('pagos_no_conciliados', { data: [{ id: FILA }], error: null });
    admins();

    await devolverEvaluacionSinConsulta(EXP, 'Estudio cerrado', 'user-1');

    expect(upsertNoConciliado()).toMatchObject({
      provider_payment_id: 'mp-77',
      motivo: 'estudio_cerrado_sin_consulta',
      estado_proveedor: 'completed',
      monto: 80000,
    });
    expect(mockRefund).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(mockNotificarYCorreo).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'admin-1', titulo: 'Evaluación por devolver en Mercado Pago', mensaje: expect.stringContaining('Reembolsar en Mercado Pago') }),
      ),
    );
  });

  it('con consulta al buró no se devuelve nada (para conservarlo está la reasignación)', async () => {
    enqueue('pagos', { data: [], error: null });
    enqueue('pagos', { data: pagoMp, error: null });
    enqueue('estudios', { data: [{ estado: 'completado', referencia_proveedor: 'tu-1' }], error: null });

    await devolverEvaluacionSinConsulta(EXP, 'Estudio rechazado', 'user-1');

    expect(mockDevolverCredito).not.toHaveBeenCalled();
    expect(upsertNoConciliado()).toBeUndefined();
  });
});

describe('no se cobra la evaluación de un estudio cerrado', () => {
  it('el enlace genérico de cobro del estudio: 409 sin crear el pago', async () => {
    enqueue('expedientes', { data: { id: EXP, numero: 'EXP-1', estado: 'cerrado' }, error: null });

    await expect(
      createPaymentLink(
        EXP,
        { concepto: 'estudio', monto: 80000, descripcion: 'Evaluación', email_pagador: 'p@x.co', nombre_pagador: 'P', enviar_email: false } as never,
        'admin-1',
        'administrador',
      ),
    ).rejects.toMatchObject({ statusCode: 409, errorCode: 'EXPEDIENTE_CERRADO' });
    expect(ops.some((o) => o.table === 'pagos' && o.method === 'insert')).toBe(false);
  });
});

describe('pago que entra después del cierre', () => {
  it('no sigue al orquestador (ni factura ni evaluación): queda para devolver', async () => {
    mockStatus.mockResolvedValueOnce({
      status: 'completed',
      transactionRef: 'mp-77',
      rawResponse: { external_reference: `estudio:${EXP}:${PAGO}`, transaction_amount: 80000 },
    });
    enqueue(
      'pagos',
      { data: { id: PAGO, estado: 'pendiente', monto: 80000, expediente_id: EXP, transaction_ref: null }, error: null },
      { data: { id: PAGO, expediente_id: EXP, concepto: 'estudio' }, error: null }, // dispatch
      { data: pagoMp, error: null }, // retener
    );
    enqueue('expedientes', { data: { estado: 'cerrado' }, error: null });
    enqueue('estudios', { data: [], error: null });
    enqueue('pagos_no_conciliados', { data: [{ id: FILA }], error: null });
    admins();

    await processWebhookEvent(Buffer.from('{}'), {});

    expect(mockTransitionChecked).toHaveBeenCalledWith(expect.objectContaining({ pagoId: PAGO, targetEstado: 'completado' }));
    expect(mockOnPagoConfirmado).not.toHaveBeenCalled();
    expect(upsertNoConciliado()).toMatchObject({ provider_payment_id: 'mp-77', motivo: 'estudio_cerrado_sin_consulta' });
  });
});

describe('«Reembolsar en Mercado Pago» (administrador)', () => {
  const fila = (resuelto = false) =>
    enqueue('pagos_no_conciliados', {
      data: {
        id: FILA, proveedor: 'mercadopago', provider_payment_id: 'mp-77', external_reference: `estudio:${EXP}:${PAGO}`,
        monto: 80000, motivo: 'estudio_cerrado_sin_consulta', notas: null, resuelto, created_at: '2026-09-24',
      },
      error: null,
    });
  const admin = { id: 'admin-1', email: 'admin@cofianza.co' };

  it('reembolsa una sola vez, deja el registro y pasa el cobro a reembolsado', async () => {
    fila();
    enqueue('pagos_no_conciliados', { data: [{ id: FILA }], error: null }); // CAS
    mockStatus.mockResolvedValueOnce({ status: 'completed', transactionRef: 'mp-77', rawResponse: {} });
    mockRefund.mockResolvedValueOnce({ refundId: 'r-1', status: 'succeeded', rawResponse: {} });
    enqueue('pagos', { data: { id: PAGO, expediente_id: EXP, estado: 'completado' }, error: null });
    enqueue('facturas', { data: { factus_number: 'FE-12' }, error: null });

    const r = await reembolsarEnMercadoPago(FILA, admin);

    expect(r).toEqual({ estado: 'reembolsado', refund_id: 'r-1', factura_numero: 'FE-12' });
    expect(mockRefund).toHaveBeenCalledTimes(1);
    expect(mockRefund).toHaveBeenCalledWith('mp-77');
    expect(ops.some((o) => o.table === 'pagos_no_conciliados' && o.method === 'eq' && o.args[0] === 'resuelto' && o.args[1] === false)).toBe(true);
    const notas = ops.filter((o) => o.table === 'pagos_no_conciliados' && o.method === 'update').map((o) => (o.args[0] as { notas?: string }).notas);
    expect(notas.at(-1)).toContain('admin@cofianza.co');
    expect(notas.at(-1)).toContain('r-1');
    expect(mockTransition).toHaveBeenCalledWith(expect.objectContaining({ pagoId: PAGO, targetEstado: 'reembolsado' }));
    expect(ops.some((o) => o.table === 'pagos' && o.method === 'eq' && o.args[0] === 'transaction_ref' && o.args[1] === 'mp-77')).toBe(true);
  });

  it('un pago duplicado se reembolsa sin tocar el cobro que sí se pagó con el primero', async () => {
    enqueue('pagos_no_conciliados', {
      data: {
        id: FILA, proveedor: 'mercadopago', provider_payment_id: 'mp-dup', external_reference: `estudio:${EXP}:${PAGO}`,
        monto: 80000, motivo: 'pago_duplicado', notas: null, resuelto: false, created_at: '2026-06-22',
      },
      error: null,
    });
    enqueue('pagos_no_conciliados', { data: [{ id: FILA }], error: null });
    mockStatus.mockResolvedValueOnce({ status: 'completed', transactionRef: 'mp-dup', rawResponse: {} });
    mockRefund.mockResolvedValueOnce({ refundId: 'r-2', status: 'succeeded', rawResponse: {} });
    enqueue('pagos', { data: null, error: null }); // ningún cobro se pagó con mp-dup

    expect(await reembolsarEnMercadoPago(FILA, admin)).toEqual({ estado: 'reembolsado', refund_id: 'r-2', factura_numero: null });
    expect(mockRefund).toHaveBeenCalledWith('mp-dup');
    expect(mockTransition).not.toHaveBeenCalled();
  });

  it('ya resuelto: 409 sin llamar a Mercado Pago', async () => {
    fila(true);

    await expect(reembolsarEnMercadoPago(FILA, admin)).rejects.toMatchObject({ statusCode: 409, errorCode: 'REEMBOLSO_RESUELTO' });
    expect(mockRefund).not.toHaveBeenCalled();
  });

  it('otro administrador lo tomó primero: 409 sin reembolsar', async () => {
    fila();
    mockStatus.mockResolvedValueOnce({ status: 'completed', transactionRef: 'mp-77', rawResponse: {} });
    enqueue('pagos_no_conciliados', { data: [], error: null }); // CAS perdido

    await expect(reembolsarEnMercadoPago(FILA, admin)).rejects.toMatchObject({ errorCode: 'REEMBOLSO_EN_CURSO' });
    expect(mockRefund).not.toHaveBeenCalled();
  });

  it('si Mercado Pago falla, la fila vuelve a quedar pendiente con el motivo', async () => {
    fila();
    enqueue('pagos_no_conciliados', { data: [{ id: FILA }], error: null });
    mockStatus.mockResolvedValueOnce({ status: 'completed', transactionRef: 'mp-77', rawResponse: {} });
    mockRefund.mockRejectedValueOnce(new Error('Error de pasarela: saldo insuficiente'));

    await expect(reembolsarEnMercadoPago(FILA, admin)).rejects.toMatchObject({ statusCode: 502, errorCode: 'REEMBOLSO_FALLIDO' });
    const ultimo = ops.filter((o) => o.table === 'pagos_no_conciliados' && o.method === 'update').at(-1)?.args[0];
    expect(ultimo).toMatchObject({ resuelto: false, notas: expect.stringContaining('saldo insuficiente') });
    expect(mockTransition).not.toHaveBeenCalled();
  });

  it('si Mercado Pago ya lo devolvió, no se vuelve a reembolsar', async () => {
    fila();
    mockStatus.mockResolvedValueOnce({ status: 'refunded', transactionRef: 'mp-77', rawResponse: {} });

    expect(await reembolsarEnMercadoPago(FILA, admin)).toMatchObject({ estado: 'ya_reembolsado' });
    expect(mockRefund).not.toHaveBeenCalled();
  });
});
