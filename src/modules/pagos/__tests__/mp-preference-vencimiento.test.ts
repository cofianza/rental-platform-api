import { describe, it, expect, vi, beforeEach } from 'vitest';

// El recibo de efectivo del cobro del estudio vence a los 15 días (Flujo §12/§14):
// sin fecha, un recibo abandonado dejaba el cobro 'procesando' para siempre.

vi.mock('@/config', () => ({ env: { MERCADOPAGO_ACCESS_TOKEN: 'TEST-token', API_PUBLIC_URL: '' } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { MercadoPagoAdapter, fechaBogota } from '../gateway/mercadopago.adapter';

const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'pref-1', init_point: 'https://mp/checkout' }), { status: 201 }));
vi.stubGlobal('fetch', fetchMock);

const crear = (concepto: string) =>
  new MercadoPagoAdapter().createPaymentLink({
    amount: 80000,
    concept: 'Evaluación',
    description: 'x',
    metadata: { concepto, expediente_id: 'exp-1', pago_id: 'pago-1' },
    successUrl: 'https://cofianza.co/pago/resultado',
    cancelUrl: 'https://cofianza.co/pago/resultado',
  });
const body = () => JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));

beforeEach(() => {
  fetchMock.mockClear();
});

describe('preference de Mercado Pago', () => {
  it('estudio: date_of_expiration a 15 días, en hora de Bogotá', async () => {
    const antes = Date.now();
    await crear('estudio');
    const vence = body().date_of_expiration as string;

    expect(vence).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}-05:00$/);
    expect(Math.round((Date.parse(vence) - antes) / 86_400_000)).toBe(15);
  });

  it('otros conceptos no cambian', async () => {
    await crear('garantia');
    expect(body()).not.toHaveProperty('date_of_expiration');
  });

  it('fechaBogota es el mismo instante con offset -05:00', () => {
    expect(fechaBogota(Date.parse('2026-10-10T17:00:00.000Z'))).toBe('2026-10-10T12:00:00.000-05:00');
  });
});
