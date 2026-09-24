import { describe, it, expect, vi, beforeEach } from 'vitest';

// P1: estudio cerrado o rechazado ya pagado y sin consulta al buró → se
// devuelve a quien pagó. El crédito vuelve solo; Mercado Pago queda en la cola
// de reembolsos para que un administrador lo haga («Reembolsar en Mercado
// Pago», idempotente y con registro). El pago que entra después del cierre,
// igual. Mock de Supabase con colas por tabla, como mp-webhook-cancelled.

const {
  mockFrom, ops, queues, enqueue, mockStatus, mockRefund, mockTransitionChecked, mockTransition,
  mockOnPagoConfirmado, mockNotificarYCorreo, mockDevolverCredito, mockEsCredito,
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
    mockEsCredito: vi.fn(async () => false),
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
vi.mock('@/modules/creditos-estudios/creditos-estudios.service', () => ({
  devolverCreditoDePago: mockDevolverCredito,
  esPagoConCredito: mockEsCredito,
}));
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

import { processWebhookEvent, createPaymentLink, registerManualPayment, reconcileMercadoPagoPayment, MOTIVOS_SIN_REEMBOLSO } from '../pagos.service';
import {
  devolverEvaluacionSinConsulta,
  reembolsarEnMercadoPago,
  resolverReembolso,
  revisarReembolsosEnProceso,
  barrerDevolucionesPendientes,
} from '../reembolsos.service';

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
const updates = (table: string) => ops.filter((o) => o.table === table && o.method === 'update').map((o) => o.args[0] as Record<string, unknown>);
const sinCobrosVivos = () => enqueue('pagos', { data: [], error: null });

beforeEach(() => {
  queues.clear();
  ops.length = 0;
  vi.clearAllMocks();
  mockTransitionChecked.mockResolvedValue({ pago: null, transitioned: true });
  mockDevolverCredito.mockResolvedValue('no_es_credito');
  mockEsCredito.mockResolvedValue(false);
});

describe('al cerrar o rechazar el estudio', () => {
  it('cancela los cobros vivos de la evaluación, incluido el fallido (Mercado Pago deja reintentar)', async () => {
    sinCobrosVivos();
    enqueue('pagos', { data: null, error: null }); // sin pago completado

    await devolverEvaluacionSinConsulta(EXP, 'Estudio cerrado', 'user-1');

    const filtro = ops.find((o) => o.table === 'pagos' && o.method === 'in' && o.args[0] === 'estado');
    expect(filtro?.args[1]).toEqual(['pendiente', 'procesando', 'fallido']);
    expect(mockDevolverCredito).not.toHaveBeenCalled();
  });

  it('pagado con crédito y sin consulta al buró: cancela la evaluación (CAS) y el crédito vuelve solo', async () => {
    sinCobrosVivos();
    enqueue('pagos', { data: { ...pagoMp, metodo: 'transferencia', transaction_ref: null }, error: null });
    enqueue(
      'estudios',
      { data: [{ id: 'est-1', estado: 'formulario_completado', referencia_proveedor: null }], error: null },
      { data: [{ id: 'est-1' }], error: null }, // CAS a cancelado
    );
    mockDevolverCredito.mockResolvedValueOnce('devuelto');

    await devolverEvaluacionSinConsulta(EXP, 'Estudio cerrado', 'user-1');

    expect(updates('estudios')).toEqual([{ estado: 'cancelado' }]);
    expect(ops.some((o) => o.table === 'estudios' && o.method === 'eq' && o.args[0] === 'estado' && o.args[1] === 'formulario_completado')).toBe(true);
    expect(mockDevolverCredito).toHaveBeenCalledWith(PAGO, 'Estudio cerrado', 'user-1');
    expect(upsertNoConciliado()).toBeUndefined();
  });

  it('P3: si ejecutarEstudio tomó la evaluación antes del CAS, no se devuelve', async () => {
    sinCobrosVivos();
    enqueue('pagos', { data: pagoMp, error: null });
    enqueue(
      'estudios',
      { data: [{ id: 'est-1', estado: 'formulario_completado', referencia_proveedor: null }], error: null },
      { data: [], error: null }, // CAS perdido: se movió
      { data: [{ id: 'est-1', estado: 'en_proceso', referencia_proveedor: null }], error: null }, // relectura
    );

    await devolverEvaluacionSinConsulta(EXP, 'Estudio cerrado', 'user-1');

    expect(mockDevolverCredito).not.toHaveBeenCalled();
    expect(upsertNoConciliado()).toBeUndefined();
  });

  it('pagado por Mercado Pago y sin consulta: queda como reembolso pendiente y se avisa, sin reembolsar solo', async () => {
    sinCobrosVivos();
    enqueue('pagos', { data: pagoMp, error: null });
    enqueue('estudios', { data: [], error: null });
    enqueue('pagos_no_conciliados', { data: null, error: null }, { data: [{ id: FILA }], error: null }); // sin fila → upsert
    admins();

    await devolverEvaluacionSinConsulta(EXP, 'Estudio cerrado', 'user-1');

    expect(upsertNoConciliado()).toMatchObject({
      proveedor: 'mercadopago',
      provider_payment_id: 'mp-77',
      motivo: 'estudio_cerrado_sin_consulta',
      estado_proveedor: 'completed',
      monto: 80000,
    });
    expect(mockRefund).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(mockNotificarYCorreo).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'admin-1',
          titulo: 'Evaluación por devolver en Mercado Pago',
          link: '/facturacion?tab=reembolsos',
          mensaje: expect.stringContaining('Reembolsar en Mercado Pago'),
        }),
      ),
    );
  });

  it('pagado a mano: también va a la cola (se devuelve por el mismo medio y se marca resuelto)', async () => {
    sinCobrosVivos();
    enqueue('pagos', { data: { ...pagoMp, metodo: 'transferencia', transaction_ref: null }, error: null });
    enqueue('estudios', { data: [], error: null });
    enqueue('pagos_no_conciliados', { data: null, error: null }, { data: [{ id: FILA }], error: null }); // sin fila → upsert
    admins();

    await devolverEvaluacionSinConsulta(EXP, 'Estudio cerrado', 'user-1');

    expect(upsertNoConciliado()).toMatchObject({ proveedor: 'manual', provider_payment_id: `pago:${PAGO}`, motivo: 'estudio_cerrado_sin_consulta' });
  });

  it('P11: si la única evaluación falló (no se sabe si la central cobró), queda en la cola para revisión', async () => {
    sinCobrosVivos();
    enqueue('pagos', { data: { ...pagoMp, metodo: 'transferencia', transaction_ref: null }, error: null });
    enqueue('estudios', { data: [{ id: 'est-1', estado: 'fallido', referencia_proveedor: null }], error: null });
    mockEsCredito.mockResolvedValueOnce(true);
    enqueue('pagos_no_conciliados', { data: null, error: null }, { data: [{ id: FILA }], error: null });
    admins();

    await devolverEvaluacionSinConsulta(EXP, 'Estudio rechazado', 'user-1');

    expect(upsertNoConciliado()).toMatchObject({ proveedor: 'credito', provider_payment_id: `pago:${PAGO}`, motivo: 'estudio_fallido_revisar' });
    expect(mockDevolverCredito).not.toHaveBeenCalled();
    // Q5c-1: la fallida no se cancela: es la marca de «dudosa» (el reintento ya
    // lo impide ejecutarEstudio con el estudio rechazado o cerrado).
    expect(updates('estudios')).toEqual([]);
  });

  it('Q5c-1: una segunda pasada (rechazado y después cerrado) no vuelve a decidir: el cobro ya está en la cola', async () => {
    sinCobrosVivos();
    enqueue('pagos', { data: { ...pagoMp, metodo: 'transferencia', transaction_ref: null }, error: null });
    enqueue('pagos_no_conciliados', { data: { id: FILA }, error: null }); // la fila dudosa de la primera pasada
    mockDevolverCredito.mockResolvedValue('devuelto'); // lo que haría si se volviera a decidir

    await devolverEvaluacionSinConsulta(EXP, 'Estudio cerrado', 'user-1');

    expect(ops.find((o) => o.table === 'pagos_no_conciliados' && o.method === 'in')?.args).toEqual(['provider_payment_id', [`pago:${PAGO}`]]);
    expect(mockDevolverCredito).not.toHaveBeenCalled();
    expect(ops.some((o) => o.table === 'estudios')).toBe(false);
    expect(upsertNoConciliado()).toBeUndefined();
  });

  it('con consulta al buró no se devuelve nada (para conservarlo está la reasignación)', async () => {
    sinCobrosVivos();
    enqueue('pagos', { data: pagoMp, error: null });
    enqueue('estudios', { data: [{ id: 'est-1', estado: 'completado', referencia_proveedor: 'tu-1' }], error: null });

    await devolverEvaluacionSinConsulta(EXP, 'Estudio rechazado', 'user-1');

    expect(mockDevolverCredito).not.toHaveBeenCalled();
    expect(upsertNoConciliado()).toBeUndefined();
  });
});

describe('no se cobra la evaluación de un estudio cerrado o rechazado', () => {
  it.each(['cerrado', 'rechazado'])('el enlace genérico de cobro del estudio %s: 409 sin crear el pago', async (estado) => {
    enqueue('expedientes', { data: { id: EXP, numero: 'EXP-1', estado }, error: null });

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

  it.each(['cerrado', 'rechazado'])('P8: el pago manual de la evaluación de un estudio %s: 409 sin registrarlo', async (estado) => {
    enqueue('expedientes', { data: { id: EXP, estado }, error: null });

    await expect(
      registerManualPayment(
        EXP,
        { concepto: 'estudio', monto: 80000, metodo: 'transferencia', fecha_pago: '2026-09-20' } as never,
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

describe('P1: webhook de un reembolso', () => {
  const reembolso = (transactionRef: string) =>
    mockStatus.mockResolvedValueOnce({
      status: 'refunded',
      transactionRef,
      rawResponse: { status: 'refunded', external_reference: `estudio:${EXP}:${PAGO}` },
    });
  const cobro = () =>
    enqueue('pagos', { data: { id: PAGO, estado: 'completado', monto: 80000, expediente_id: EXP, transaction_ref: 'mp-77' }, error: null });

  it('el reembolso de OTRO payment (un duplicado) cierra su fila y no toca el cobro legítimo', async () => {
    reembolso('mp-dup');
    enqueue('pagos_no_conciliados', { data: { id: FILA, notas: 'Pago duplicado' }, error: null });
    cobro();

    await reconcileMercadoPagoPayment('mp-dup');

    expect(mockTransitionChecked).not.toHaveBeenCalled();
    expect(updates('pagos_no_conciliados')[0]).toMatchObject({ resuelto: true, estado_proveedor: 'refunded' });
    expect(ops.some((o) => o.table === 'pagos_no_conciliados' && o.method === 'eq' && o.args[1] === 'mp-dup')).toBe(true);
  });

  it('Q5b-7: el payment del cobro reembolsado vuelve aprobado (contracargo ganado): a la cola sin «Reembolsar» de un clic', async () => {
    mockStatus.mockResolvedValueOnce({
      status: 'completed',
      transactionRef: 'mp-77',
      rawResponse: { status: 'approved', external_reference: `estudio:${EXP}:${PAGO}`, transaction_amount: 80000 },
    });
    enqueue('pagos', { data: { id: PAGO, estado: 'reembolsado', monto: 80000, expediente_id: EXP, transaction_ref: 'mp-77' }, error: null });
    enqueue('pagos_no_conciliados', { data: [{ id: FILA }], error: null });
    admins();

    await processWebhookEvent(Buffer.from('{}'), {});

    expect(upsertNoConciliado()).toMatchObject({ provider_payment_id: 'mp-77', motivo: 'contracargo_ganado' });
    expect(MOTIVOS_SIN_REEMBOLSO).toContain('contracargo_ganado');
    expect(mockTransitionChecked).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(mockNotificarYCorreo).toHaveBeenCalledWith(expect.objectContaining({ titulo: 'Contracargo ganado: restituir a mano' })),
    );
  });

  it('Q5b-7: contracargo ganado de un cobro (charged_back + reimbursed): no lo toca y avisa', async () => {
    mockStatus.mockResolvedValueOnce({
      status: 'refunded',
      transactionRef: 'mp-77',
      rawResponse: { status: 'charged_back', status_detail: 'reimbursed', external_reference: `estudio:${EXP}:${PAGO}` },
    });
    admins();

    await processWebhookEvent(Buffer.from('{}'), {});

    expect(mockTransitionChecked).not.toHaveBeenCalled();
    expect(ops.some((o) => o.table === 'pagos' || o.table === 'pagos_no_conciliados')).toBe(false);
    expect(mockNotificarYCorreo).toHaveBeenCalledWith(
      expect.objectContaining({ tipo: 'pago.contracargo_ganado', link: `/expedientes/${EXP}`, mensaje: expect.stringContaining('restitúyelo a mano') }),
    );
  });

  it('Q5b-10: reembolso parcial de un cobro: a la cola con aviso, el cobro sigue como está', async () => {
    mockStatus.mockResolvedValueOnce({
      status: 'completed',
      transactionRef: 'mp-77',
      rawResponse: { status: 'approved', status_detail: 'partially_refunded', external_reference: `estudio:${EXP}:${PAGO}`, transaction_amount: 80000 },
    });
    cobro();
    enqueue('pagos_no_conciliados', { data: [{ id: FILA }], error: null });
    admins();

    await processWebhookEvent(Buffer.from('{}'), {});

    expect(upsertNoConciliado()).toMatchObject({ provider_payment_id: 'mp-77', motivo: 'reembolso_parcial' });
    expect(mockTransitionChecked).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(mockNotificarYCorreo).toHaveBeenCalledWith(
        expect.objectContaining({ titulo: 'Reembolso parcial de un pago', link: '/facturacion?tab=reembolsos' }),
      ),
    );
  });

  it('el reembolso del payment del cobro lo pasa a reembolsado y, si tenía factura, avisa la nota crédito', async () => {
    reembolso('mp-77');
    cobro();
    enqueue('facturas', { data: { id: 'fac-1', factus_number: 'FE-12' }, error: null });
    admins();

    await processWebhookEvent(Buffer.from('{}'), {});

    expect(mockTransitionChecked).toHaveBeenCalledWith(expect.objectContaining({ pagoId: PAGO, targetEstado: 'reembolsado' }));
    expect(mockNotificarYCorreo).toHaveBeenCalledWith(
      expect.objectContaining({ tipo: 'factura.nota_credito', mensaje: expect.stringContaining('Emitir nota crédito en Factus para la factura FE-12') }),
    );
  });
});

describe('Q5b-5: pago sin cobro que entró pendiente y después se aprobó', () => {
  it('su fila pasa a aprobada (aparece en la cola) y se avisa', async () => {
    mockStatus.mockResolvedValueOnce({ status: 'completed', transactionRef: 'mp-77', rawResponse: { external_reference: '', transaction_amount: 5000 } });
    enqueue('pagos_no_conciliados', { data: [], error: null }, { data: [{ id: FILA }], error: null }); // ya existía (pendiente) → pasa a completed
    admins();

    await processWebhookEvent(Buffer.from('{}'), {});

    expect(updates('pagos_no_conciliados')[0]).toMatchObject({ estado_proveedor: 'completed', monto: 5000 });
    expect(ops.some((o) => o.table === 'pagos_no_conciliados' && o.method === 'eq' && o.args[0] === 'resuelto' && o.args[1] === false)).toBe(true);
    await vi.waitFor(() =>
      expect(mockNotificarYCorreo).toHaveBeenCalledWith(
        expect.objectContaining({ tipo: 'pago.no_conciliado', mensaje: expect.stringContaining('(aprobado)') }),
      ),
    );
  });
});

describe('«Reembolsar en Mercado Pago» (administrador)', () => {
  const fila = (extra: Record<string, unknown> = {}) =>
    enqueue('pagos_no_conciliados', {
      data: {
        id: FILA, proveedor: 'mercadopago', provider_payment_id: 'mp-77', external_reference: `estudio:${EXP}:${PAGO}`,
        monto: 80000, motivo: 'estudio_cerrado_sin_consulta', notas: null, resuelto: false, estado_proveedor: 'completed',
        created_at: '2026-09-24', ...extra,
      },
      error: null,
    });
  const cobro = () => enqueue('pagos', { data: { id: PAGO, expediente_id: EXP, estado: 'completado' }, error: null });
  const sinConsulta = () => enqueue('estudios', { data: [{ id: 'est-1', estado: 'cancelado', referencia_proveedor: null }], error: null });
  const admin = { id: 'admin-1', email: 'admin@cofianza.co' };

  it('reembolsa una sola vez, deja el registro, pasa el cobro a reembolsado y avisa la nota crédito', async () => {
    fila();
    cobro();
    sinConsulta();
    enqueue('pagos_no_conciliados', { data: [{ id: FILA }], error: null }); // CAS
    mockStatus.mockResolvedValueOnce({ status: 'completed', transactionRef: 'mp-77', rawResponse: {} });
    mockRefund.mockResolvedValueOnce({ refundId: 'r-1', status: 'succeeded', rawResponse: {} });
    enqueue('facturas', { data: { id: 'fac-1', factus_number: 'FE-12' }, error: null });
    admins();

    const r = await reembolsarEnMercadoPago(FILA, admin);

    expect(r).toEqual({ estado: 'reembolsado', refund_id: 'r-1', factura_numero: 'FE-12' });
    expect(mockRefund).toHaveBeenCalledTimes(1);
    expect(mockRefund).toHaveBeenCalledWith('mp-77');
    const [tomada, final] = updates('pagos_no_conciliados');
    expect(tomada).toMatchObject({ estado_proveedor: 'reembolso_en_proceso' });
    expect(final).toMatchObject({ resuelto: true, estado_proveedor: 'refunded', notas: expect.stringContaining('r-1') });
    expect(final.notas).toContain('admin@cofianza.co');
    expect(mockTransitionChecked).toHaveBeenCalledWith(expect.objectContaining({ pagoId: PAGO, targetEstado: 'reembolsado' }));
    expect(mockNotificarYCorreo).toHaveBeenCalledWith(expect.objectContaining({ tipo: 'factura.nota_credito' }));
  });

  it('P12: si el reembolso queda en proceso, la fila no se resuelve ni el cobro cambia (lo cierra el webhook)', async () => {
    fila();
    cobro();
    sinConsulta();
    enqueue('pagos_no_conciliados', { data: [{ id: FILA }], error: null });
    mockStatus.mockResolvedValueOnce({ status: 'completed', transactionRef: 'mp-77', rawResponse: {} });
    mockRefund.mockResolvedValueOnce({ refundId: 'r-3', status: 'pending', rawResponse: {} });

    expect(await reembolsarEnMercadoPago(FILA, admin)).toMatchObject({ estado: 'en_proceso', refund_id: 'r-3' });
    const final = updates('pagos_no_conciliados').at(-1)!;
    expect(final.resuelto).toBeUndefined();
    expect(final.notas).toContain('en proceso');
    expect(mockTransitionChecked).not.toHaveBeenCalled();
  });

  it('P3: si la evaluación llegó al buró después de encolarse, no se devuelve', async () => {
    fila();
    cobro();
    enqueue('estudios', { data: [{ id: 'est-1', estado: 'completado', referencia_proveedor: 'tu-1' }], error: null });

    await expect(reembolsarEnMercadoPago(FILA, admin)).rejects.toMatchObject({ statusCode: 409, errorCode: 'CONSULTA_AL_BURO' });
    expect(mockRefund).not.toHaveBeenCalled();
  });

  it('Q5b-2: la fila dudosa (la única consulta falló) no se reembolsa si al final la evaluación sí llegó al buró', async () => {
    fila({ motivo: 'estudio_fallido_revisar' });
    cobro();
    enqueue('estudios', { data: [{ id: 'est-1', estado: 'completado', referencia_proveedor: 'TU-123' }], error: null });

    await expect(reembolsarEnMercadoPago(FILA, admin)).rejects.toMatchObject({ statusCode: 409, errorCode: 'CONSULTA_AL_BURO' });
    expect(mockRefund).not.toHaveBeenCalled();
  });

  it('un pago duplicado se reembolsa sin tocar el cobro que sí se pagó con el primero', async () => {
    fila({ provider_payment_id: 'mp-dup', motivo: 'pago_duplicado', created_at: '2026-06-22' });
    enqueue('pagos', { data: null, error: null }); // ningún cobro se pagó con mp-dup
    enqueue('pagos_no_conciliados', { data: [{ id: FILA }], error: null });
    mockStatus.mockResolvedValueOnce({ status: 'completed', transactionRef: 'mp-dup', rawResponse: {} });
    mockRefund.mockResolvedValueOnce({ refundId: 'r-2', status: 'succeeded', rawResponse: {} });

    expect(await reembolsarEnMercadoPago(FILA, admin)).toEqual({ estado: 'reembolsado', refund_id: 'r-2', factura_numero: null });
    expect(mockRefund).toHaveBeenCalledWith('mp-dup');
    expect(mockTransitionChecked).not.toHaveBeenCalled();
  });

  it('P9: lo que no se reembolsa completo (transición fallida, reembolso parcial) no ofrece Reembolsar', async () => {
    fila({ motivo: 'transicion_fallida' });

    await expect(reembolsarEnMercadoPago(FILA, admin)).rejects.toMatchObject({ errorCode: 'REEMBOLSO_NO_APLICA' });
    expect(mockRefund).not.toHaveBeenCalled();
  });

  it('ya resuelto: 409 sin llamar a Mercado Pago', async () => {
    fila({ resuelto: true });

    await expect(reembolsarEnMercadoPago(FILA, admin)).rejects.toMatchObject({ statusCode: 409, errorCode: 'REEMBOLSO_RESUELTO' });
    expect(mockRefund).not.toHaveBeenCalled();
  });

  it('otro administrador lo tomó primero: 409 sin reembolsar', async () => {
    fila();
    cobro();
    sinConsulta();
    mockStatus.mockResolvedValueOnce({ status: 'completed', transactionRef: 'mp-77', rawResponse: {} });
    enqueue('pagos_no_conciliados', { data: [], error: null }); // CAS perdido

    await expect(reembolsarEnMercadoPago(FILA, admin)).rejects.toMatchObject({ errorCode: 'REEMBOLSO_EN_CURSO' });
    expect(mockRefund).not.toHaveBeenCalled();
  });

  it('si Mercado Pago falla, la fila vuelve a quedar por resolver con el motivo', async () => {
    fila();
    cobro();
    sinConsulta();
    enqueue('pagos_no_conciliados', { data: [{ id: FILA }], error: null });
    mockStatus.mockResolvedValueOnce({ status: 'completed', transactionRef: 'mp-77', rawResponse: {} });
    mockRefund.mockRejectedValueOnce(new Error('Error de pasarela: saldo insuficiente'));

    await expect(reembolsarEnMercadoPago(FILA, admin)).rejects.toMatchObject({ statusCode: 502, errorCode: 'REEMBOLSO_FALLIDO' });
    expect(updates('pagos_no_conciliados').at(-1)).toMatchObject({ estado_proveedor: 'completed', notas: expect.stringContaining('saldo insuficiente') });
    expect(mockTransitionChecked).not.toHaveBeenCalled();
  });

  it('si Mercado Pago ya lo devolvió, no se vuelve a reembolsar: se procesa como su webhook (fila y cobro)', async () => {
    fila();
    cobro();
    sinConsulta();
    const devuelto = { status: 'refunded', transactionRef: 'mp-77', rawResponse: { status: 'refunded', external_reference: `estudio:${EXP}:${PAGO}` } };
    mockStatus.mockResolvedValueOnce(devuelto).mockResolvedValueOnce(devuelto);
    enqueue('pagos_no_conciliados', { data: { id: FILA, notas: null }, error: null });
    enqueue('pagos', { data: { id: PAGO, estado: 'completado', monto: 80000, expediente_id: EXP, transaction_ref: 'mp-77' }, error: null });

    expect(await reembolsarEnMercadoPago(FILA, admin)).toMatchObject({ estado: 'ya_reembolsado' });
    expect(mockRefund).not.toHaveBeenCalled();
    expect(updates('pagos_no_conciliados')[0]).toMatchObject({ resuelto: true, estado_proveedor: 'refunded' });
    expect(mockTransitionChecked).toHaveBeenCalledWith(expect.objectContaining({ pagoId: PAGO, targetEstado: 'reembolsado' }));
  });
});

describe('P9: «Marcar resuelto» (administrador)', () => {
  const admin = { id: 'admin-1', email: 'admin@cofianza.co' };

  it('la evaluación devuelta a mano: la fila se cierra con la nota y el cobro pasa a reembolsado', async () => {
    enqueue('pagos_no_conciliados', {
      data: {
        id: FILA, proveedor: 'manual', provider_payment_id: `pago:${PAGO}`, external_reference: `estudio:${EXP}:${PAGO}`,
        monto: 80000, motivo: 'estudio_cerrado_sin_consulta', notas: null, resuelto: false, estado_proveedor: 'completed',
        created_at: '2026-09-24',
      },
      error: null,
    });
    enqueue('pagos_no_conciliados', { data: [{ id: FILA }], error: null }); // CAS
    enqueue('pagos', { data: { id: PAGO, expediente_id: EXP, estado: 'completado' }, error: null });
    enqueue('estudios', { data: [{ id: 'est-1', estado: 'cancelado', referencia_proveedor: null }], error: null });

    expect(await resolverReembolso(FILA, 'Transferencia devuelta el 24/09', admin)).toEqual({ estado: 'resuelto', factura_numero: null });

    expect(updates('pagos_no_conciliados')[0]).toMatchObject({ resuelto: true, notas: expect.stringContaining('Transferencia devuelta el 24/09') });
    expect(ops.some((o) => o.table === 'pagos' && o.method === 'eq' && o.args[0] === 'id' && o.args[1] === PAGO)).toBe(true);
    expect(mockTransitionChecked).toHaveBeenCalledWith(expect.objectContaining({ pagoId: PAGO, targetEstado: 'reembolsado' }));
    expect(mockRefund).not.toHaveBeenCalled();
  });

  it('Q5b-8: la evaluación que al final sí llegó al buró: la fila se cierra con la nota y el cobro no se reembolsa', async () => {
    enqueue('pagos_no_conciliados', {
      data: {
        id: FILA, proveedor: 'manual', provider_payment_id: `pago:${PAGO}`, external_reference: `estudio:${EXP}:${PAGO}`,
        monto: 80000, motivo: 'estudio_cerrado_sin_consulta', notas: null, resuelto: false, estado_proveedor: 'completed',
        created_at: '2026-09-24',
      },
      error: null,
    });
    enqueue('pagos_no_conciliados', { data: [{ id: FILA }], error: null }); // CAS
    enqueue('pagos', { data: { id: PAGO, expediente_id: EXP, estado: 'completado' }, error: null });
    enqueue('estudios', { data: [{ id: 'est-1', estado: 'completado', referencia_proveedor: 'TU-9' }], error: null });

    expect(await resolverReembolso(FILA, 'Revisado: sí se consultó, no se devuelve', admin)).toEqual({ estado: 'resuelto', factura_numero: null });

    expect(updates('pagos_no_conciliados')[0]).toMatchObject({ resuelto: true });
    expect(mockTransitionChecked).not.toHaveBeenCalled();
  });

  it('Q5c-4: si no se puede leer la consulta al buró, la fila no se resuelve (se puede reintentar)', async () => {
    enqueue('pagos_no_conciliados', {
      data: {
        id: FILA, proveedor: 'manual', provider_payment_id: `pago:${PAGO}`, external_reference: `estudio:${EXP}:${PAGO}`,
        monto: 80000, motivo: 'estudio_cerrado_sin_consulta', notas: null, resuelto: false, estado_proveedor: 'completed',
        created_at: '2026-09-24',
      },
      error: null,
    });
    enqueue('pagos', { data: { id: PAGO, expediente_id: EXP, estado: 'completado' }, error: null });
    enqueue('estudios', { data: null, error: { message: 'timeout', code: '57014' } });

    await expect(resolverReembolso(FILA, 'Transferencia devuelta', admin)).rejects.toBeTruthy();
    expect(updates('pagos_no_conciliados')).toEqual([]);
    expect(mockTransitionChecked).not.toHaveBeenCalled();
  });

  it('un pago que no se pudo asociar: se cierra con la nota y ningún cobro cambia', async () => {
    enqueue('pagos_no_conciliados', {
      data: {
        id: FILA, proveedor: 'mercadopago', provider_payment_id: 'mp-9', external_reference: 'x', monto: 150,
        motivo: 'referencia_desconocida', notas: null, resuelto: false, estado_proveedor: 'completed', created_at: '2026-09-24',
      },
      error: null,
    });
    enqueue('pagos_no_conciliados', { data: [{ id: FILA }], error: null });

    await resolverReembolso(FILA, 'Conciliado con el extracto', admin);

    expect(mockTransitionChecked).not.toHaveBeenCalled();
  });
});

describe('P12: reembolsos que quedaron en proceso', () => {
  const enProceso = () =>
    enqueue('pagos_no_conciliados', {
      data: [{
        id: FILA, proveedor: 'mercadopago', provider_payment_id: 'mp-77', external_reference: `estudio:${EXP}:${PAGO}`,
        monto: 80000, motivo: 'estudio_cerrado_sin_consulta', notas: 'Reembolso en proceso', resuelto: false,
        estado_proveedor: 'reembolso_en_proceso', created_at: '2026-09-24',
      }],
      error: null,
    });

  it('si Mercado Pago lo rechazó, la fila vuelve a quedar por resolver y se avisa', async () => {
    enProceso();
    mockStatus.mockResolvedValueOnce({ status: 'completed', transactionRef: 'mp-77', rawResponse: { refunds: [{ id: 'r-3', status: 'rejected' }] } });
    admins();

    expect(await revisarReembolsosEnProceso()).toBe(1);

    expect(updates('pagos_no_conciliados')[0]).toMatchObject({ estado_proveedor: 'completed', notas: expect.stringContaining('rechazó') });
    expect(mockNotificarYCorreo).toHaveBeenCalledWith(expect.objectContaining({ titulo: 'Un reembolso no se completó' }));
  });

  it('si sigue en proceso, no se toca', async () => {
    enProceso();
    mockStatus.mockResolvedValueOnce({ status: 'completed', transactionRef: 'mp-77', rawResponse: { refunds: [{ id: 'r-3', status: 'in_process' }] } });

    expect(await revisarReembolsosEnProceso()).toBe(0);
    expect(updates('pagos_no_conciliados')).toEqual([]);
  });
});

describe('P10: red de seguridad', () => {
  const cierre = () => enqueue('eventos_timeline', { data: [{ expediente_id: EXP }], error: null });
  const candidato = (estudios: unknown[]) => {
    cierre();
    enqueue('pagos', {
      data: [{ id: PAGO, expediente_id: EXP, transaction_ref: 'mp-77', expedientes: { estado: 'cerrado', estudios } }],
      error: null,
    });
  };

  it('encola la evaluación pagada de un estudio cerrado que no llegó a la cola', async () => {
    candidato([{ estado: 'cancelado', referencia_proveedor: null }]);
    enqueue('pagos_no_conciliados', { data: [], error: null }); // sin fila en la cola
    sinCobrosVivos();
    enqueue('pagos', { data: pagoMp, error: null });
    enqueue('estudios', { data: [], error: null });
    enqueue('pagos_no_conciliados', { data: null, error: null }, { data: [{ id: FILA }], error: null });
    admins();

    expect(await barrerDevolucionesPendientes()).toBe(1);
    expect(upsertNoConciliado()).toMatchObject({ provider_payment_id: 'mp-77', motivo: 'estudio_cerrado_sin_consulta' });
  });

  it('si ya tiene fila en la cola, no la vuelve a revisar', async () => {
    candidato([]);
    enqueue('pagos_no_conciliados', { data: [{ provider_payment_id: 'mp-77' }], error: null });

    expect(await barrerDevolucionesPendientes()).toBe(0);
    expect(ops.filter((o) => o.table === 'pagos' && o.method === 'select')).toHaveLength(1);
  });

  it('Q5b-6: los que sí consultaron el buró se descartan sin una consulta por estudio', async () => {
    candidato([{ estado: 'completado', referencia_proveedor: 'TU-1' }]);

    expect(await barrerDevolucionesPendientes()).toBe(0);
    expect(ops.some((o) => o.table === 'pagos_no_conciliados' || o.table === 'estudios')).toBe(false);
  });

  it('Q5c-6: la fecha es la del cierre o el rechazo en la línea de tiempo (no updated_at), desde el corte y lo más reciente primero', async () => {
    cierre();
    enqueue('pagos', { data: [], error: null });

    await barrerDevolucionesPendientes();

    const eventos = ops.filter((o) => o.table === 'eventos_timeline');
    expect(eventos).toContainEqual(expect.objectContaining({ method: 'in', args: ['estado_nuevo', ['cerrado', 'rechazado']] }));
    const desde = eventos.find((o) => o.method === 'gte' && o.args[0] === 'created_at')?.args[1] as string;
    expect(desde >= '2026-09-24T05:00:00.000Z').toBe(true);
    expect(eventos.find((o) => o.method === 'order')?.args).toEqual(['created_at', { ascending: false }]);
    expect(ops.find((o) => o.table === 'pagos' && o.method === 'in' && o.args[0] === 'expediente_id')?.args[1]).toEqual([EXP]);
    expect(ops.some((o) => String(o.args[0]).includes('updated_at'))).toBe(false);
  });

  it('sin cierres recientes no lee los pagos', async () => {
    enqueue('eventos_timeline', { data: [], error: null });

    expect(await barrerDevolucionesPendientes()).toBe(0);
    expect(ops.some((o) => o.table === 'pagos')).toBe(false);
  });

  it('Q5b-6: si la devolución falla en el barrido no avisa (lo reintentaría cada 15 min)', async () => {
    candidato([]);
    enqueue('pagos_no_conciliados', { data: [], error: null });
    sinCobrosVivos();
    enqueue('pagos', { data: null, error: { message: 'dos cobros completados', code: 'PGRST116' } });
    admins();

    expect(await barrerDevolucionesPendientes()).toBe(1);
    await new Promise((r) => setTimeout(r, 10));
    expect(mockNotificarYCorreo).not.toHaveBeenCalled();
  });
});


