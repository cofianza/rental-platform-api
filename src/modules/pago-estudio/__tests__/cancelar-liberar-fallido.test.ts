import { describe, it, expect, vi, beforeEach } from 'vitest';

// «Cancelar y liberar con crédito» con el cobro del prospecto 'fallido'
// (tarjeta rechazada): antes respondía PAGO_NO_CANCELABLE. Ahora pasa, y el
// fallido lo cierra liberarEstudioConCredito (cerrarCobroEstudioFallido) tras
// sus propias validaciones, no esta función.

const { queues, mockTransition, mockCancelLink, mockLiberar } = vi.hoisted(() => ({
  queues: new Map<string, Array<Record<string, unknown>>>(),
  mockTransition: vi.fn(async () => undefined),
  mockCancelLink: vi.fn(async () => undefined),
  mockLiberar: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@/lib/supabase', () => {
  const chain = (table: string): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'not', 'order', 'limit']) c[m] = () => c;
    c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(queues.get(table)?.shift() ?? { data: null, error: null }).then(resolve);
    return c;
  };
  return { supabase: { from: (t: string) => chain(t) } };
});
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn(), AUDIT_ACTIONS: {}, AUDIT_ENTITIES: {} }));
vi.mock('@/config', () => ({ env: { FRONTEND_URL: 'http://localhost:3000' } }));
vi.mock('@/lib/email', () => ({ sendPaymentLinkEmail: vi.fn() }));
vi.mock('@/modules/pagos/gateway', () => ({ getPaymentGateway: () => ({ provider: 'mercadopago', cancelPaymentLink: mockCancelLink }) }));
vi.mock('@/modules/pagos/pago-state-machine', () => ({ transitionPagoState: mockTransition }));
vi.mock('@/modules/pagos/pagos.service', () => ({ attachFacturas: vi.fn(async (p: unknown[]) => p) }));
vi.mock('@/modules/notificaciones/notificaciones.service', () => ({ notificarUsuario: vi.fn(), findPerfilIdByEmail: vi.fn() }));
vi.mock('@/modules/whatsapp', () => ({ enviarTemplate: vi.fn() }));
vi.mock('@/lib/tenantScope', () => ({ assertExpedienteAccess: vi.fn(async () => undefined) }));
vi.mock('@/modules/estudios/tope-canon.guard', () => ({ assertCanonDentroDelTope: vi.fn(async () => undefined) }));
vi.mock('@/modules/creditos-estudios/creditos-estudios.service', () => ({
  liberarEstudioConCredito: mockLiberar,
  getSaldoCreditos: vi.fn(async () => ({ saldo_total: 3, saldo_efectivo: 3, creditos_en_contra: 0 })),
  errorCreditosEnContra: vi.fn(),
}));

import { cancelarYLiberarCredito } from '../pago-estudio.service';

const EXP = '11111111-1111-1111-1111-111111111111';
const cobro = (estado: string) =>
  queues.set('pagos', [{ data: [{ id: 'p1', estado, metodo: 'pasarela', external_id: 'pref-1' }], error: null }]);

beforeEach(() => {
  queues.clear();
  vi.clearAllMocks();
});

describe('cancelarYLiberarCredito', () => {
  it('cobro fallido: libera con crédito y deja el cierre del fallido a liberarEstudioConCredito', async () => {
    cobro('fallido');

    await expect(cancelarYLiberarCredito(EXP, 'user-1', undefined, 'inmobiliaria')).resolves.toEqual({ ok: true });
    expect(mockTransition).not.toHaveBeenCalled();
    expect(mockLiberar).toHaveBeenCalledWith(EXP, 'user-1', 'user-1', undefined);
  });

  it('cobro pendiente: lo cancela, expira el link y libera', async () => {
    cobro('pendiente');

    await cancelarYLiberarCredito(EXP, 'user-1', undefined, 'inmobiliaria');
    expect(mockTransition).toHaveBeenCalledWith(expect.objectContaining({ pagoId: 'p1', targetEstado: 'cancelado' }));
    expect(mockCancelLink).toHaveBeenCalledWith('pref-1');
    expect(mockLiberar).toHaveBeenCalled();
  });

  it('cobro completado: 400 PAGO_NO_CANCELABLE sin gastar crédito', async () => {
    cobro('completado');

    await expect(cancelarYLiberarCredito(EXP, 'user-1', undefined, 'inmobiliaria')).rejects.toMatchObject({
      errorCode: 'PAGO_NO_CANCELABLE',
    });
    expect(mockLiberar).not.toHaveBeenCalled();
  });
});
