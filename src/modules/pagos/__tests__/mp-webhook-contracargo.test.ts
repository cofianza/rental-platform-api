import { describe, it, expect, vi, beforeEach } from 'vitest';

// P22: Mercado Pago reembolsa o contracarga una compra de créditos → se
// revierte la compra (creditos-estudios) y se avisa a los administradores con
// el saldo en contra y el registro de consumos para disputarlo. Mock de
// Supabase con colas por tabla, como mp-webhook-cancelled.

const { mockFrom, queues, enqueue, mockStatus, mockNotificarYCorreo, mockRevertirCompra, mockAcreditar } = vi.hoisted(() => {
  type Res = Record<string, unknown>;
  const queues = new Map<string, Res[]>();
  const next = (table: string): Res => {
    const q = queues.get(table);
    return q && q.length ? q.shift()! : { data: null, error: null };
  };
  const PASSTHROUGH = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'in', 'order', 'limit', 'gte', 'lte'];
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
    mockFrom: vi.fn((table: string) => chainFor(table)),
    queues,
    enqueue: (table: string, ...items: Res[]) => queues.set(table, [...(queues.get(table) ?? []), ...items]),
    mockStatus: vi.fn(),
    mockNotificarYCorreo: vi.fn(async () => undefined),
    mockRevertirCompra: vi.fn(),
    mockAcreditar: vi.fn(),
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
vi.mock('@/modules/orchestrator/orchestrator.service', () => ({ onPagoConfirmado: vi.fn() }));
vi.mock('@/modules/creditos-estudios/creditos-estudios.service', () => ({
  revertirCompraCreditos: mockRevertirCompra,
  acreditarCompraDesdeWebhook: mockAcreditar,
}));
vi.mock('../gateway', () => ({
  getPaymentGateway: () => ({
    provider: 'mercadopago',
    verifyWebhook: () => ({ event: {}, type: 'payment', eventId: 'mp-cb' }),
    getPaymentStatus: mockStatus,
  }),
}));

import { processWebhookEvent } from '../pagos.service';

const contracargo = () =>
  mockStatus.mockResolvedValueOnce({
    status: 'refunded',
    transactionRef: 'mp-cb',
    rawResponse: { status: 'charged_back', external_reference: 'creditos_estudios:compra-1' },
  });

beforeEach(() => {
  queues.clear();
  vi.clearAllMocks();
});

describe('webhook de Mercado Pago: contracargo de una compra de créditos', () => {
  it('revierte la compra y avisa a los administradores con el saldo en contra, los consumos y la factura', async () => {
    contracargo();
    mockRevertirCompra.mockResolvedValueOnce({
      compra_id: 'compra-1', perfil_id: 'owner-1', retirados: 4, en_contra: 6, en_contra_error: null, consumos: ['EXP-1', 'EXP-2'],
    });
    enqueue('perfiles', { data: { razon_social: 'Inmo SAS', nombre: null, apellido: null }, error: null }, { data: [{ id: 'admin-1' }], error: null });
    enqueue('facturas', { data: { factus_number: 'FE-30' }, error: null });

    await processWebhookEvent(Buffer.from('{}'), {});

    expect(mockRevertirCompra).toHaveBeenCalledWith('compra-1');
    expect(mockAcreditar).not.toHaveBeenCalled();
    expect(mockNotificarYCorreo).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'admin-1',
        tipo: 'creditos.contracargo',
        titulo: 'Contracargo de una compra de créditos',
        mensaje: expect.stringMatching(/contracargo.*Inmo SAS.*retiraron 4.*6 ya usados.*saldo en contra.*EXP-1, EXP-2.*FE-30/),
      }),
    );
  });

  it('P4: si los usados no quedaron como saldo en contra, el aviso lo dice', async () => {
    contracargo();
    mockRevertirCompra.mockResolvedValueOnce({
      compra_id: 'compra-1', perfil_id: 'owner-1', retirados: 0, en_contra: 3, en_contra_error: 'timeout', consumos: [],
    });
    enqueue('perfiles', { data: null, error: null }, { data: [{ id: 'admin-1' }], error: null });

    await processWebhookEvent(Buffer.from('{}'), {});

    expect(mockNotificarYCorreo).toHaveBeenCalledWith(
      expect.objectContaining({ mensaje: expect.stringContaining('3 ya usados NO quedaron como saldo en contra (timeout): descuéntalos a mano') }),
    );
  });

  it('un reintento del webhook sobre una compra ya revertida no vuelve a avisar', async () => {
    contracargo();
    mockRevertirCompra.mockResolvedValueOnce(null);

    await processWebhookEvent(Buffer.from('{}'), {});

    expect(mockNotificarYCorreo).not.toHaveBeenCalled();
  });

  it('si no se puede revertir, se avisa para revisarlo a mano (el webhook igual responde)', async () => {
    contracargo();
    mockRevertirCompra.mockRejectedValueOnce(new Error('lote cambiando'));
    enqueue('perfiles', { data: [{ id: 'admin-1' }], error: null });

    await expect(processWebhookEvent(Buffer.from('{}'), {})).resolves.toEqual({ received: true });
    expect(mockNotificarYCorreo).toHaveBeenCalledWith(
      expect.objectContaining({ tipo: 'creditos.contracargo', mensaje: expect.stringContaining('Revisa a mano') }),
    );
  });
});
