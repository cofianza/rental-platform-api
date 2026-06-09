import crypto from 'node:crypto';
import { env } from '@/config';
import { logger } from '@/lib/logger';
import { AppError } from '@/lib/errors';
import type {
  PaymentGatewayAdapter,
  CreatePaymentLinkParams,
  PaymentLinkResult,
  PaymentStatus,
  RefundResult,
  WebhookVerifyResult,
  GatewayHealthStatus,
} from './types';

// ============================================================
// Mercado Pago Adapter (Checkout Pro)
//
// Pasarela para Colombia (Stripe no opera en CO). Usa Checkout Pro:
//   - createPaymentLink → crea una "preference" y devuelve su init_point (URL).
//   - El webhook es solo un aviso ("payment" + data.id); el estado real se
//     consulta con GET /v1/payments/{id}. El cruce con NUESTRO pago va por
//     `external_reference` = "<concepto>:<expediente_id|compra_id>".
//   - Firma del webhook: header x-signature (ts,v1) + x-request-id + data.id,
//     HMAC-SHA256 del manifest "id:..;request-id:..;ts:..;" con el secreto.
//
// Requiere en .env: MERCADOPAGO_ACCESS_TOKEN (+ MERCADOPAGO_WEBHOOK_SECRET para
// validar el webhook, MERCADOPAGO_PUBLIC_KEY para el front si se necesita).
// ============================================================

const MP_API = 'https://api.mercadopago.com';
const MP_TIMEOUT_MS = 15_000;

interface MpPreferenceResponse {
  id: string;
  init_point?: string;
  sandbox_init_point?: string;
}

interface MpPaymentResponse {
  id: number | string;
  status?: string;
  status_detail?: string;
  external_reference?: string | null;
  transaction_amount?: number;
  metadata?: Record<string, unknown>;
}

export class MercadoPagoAdapter implements PaymentGatewayAdapter {
  readonly provider = 'mercadopago';
  private readonly accessToken: string;

  constructor() {
    this.accessToken = env.MERCADOPAGO_ACCESS_TOKEN;
    if (!this.accessToken) {
      throw new Error(
        'MERCADOPAGO_ACCESS_TOKEN no está configurado (requerido cuando PAYMENT_GATEWAY_PROVIDER=mercadopago)',
      );
    }
  }

  // ----------------------------------------------------------
  // Create payment link (Checkout Pro preference)
  // ----------------------------------------------------------

  async createPaymentLink(params: CreatePaymentLinkParams): Promise<PaymentLinkResult> {
    const { amount, concept, description, metadata, successUrl, cancelUrl } = params;

    // external_reference es el ÚNICO dato que MP propaga del preference al payment,
    // así que codificamos ahí cómo enrutar el webhook: "<concepto>:<id>".
    const refId = metadata.expediente_id ?? metadata.compra_id ?? '';
    const externalReference = `${metadata.concepto ?? 'pago'}:${refId}`;

    const body: Record<string, unknown> = {
      items: [
        {
          title: concept,
          description,
          quantity: 1,
          currency_id: 'COP',
          // COP no tiene subunidades: el monto va tal cual (a diferencia de Stripe).
          unit_price: amount,
        },
      ],
      external_reference: externalReference,
      metadata,
      back_urls: { success: successUrl, failure: cancelUrl, pending: successUrl },
      auto_return: 'approved',
      ...(env.API_PUBLIC_URL
        ? { notification_url: `${env.API_PUBLIC_URL.replace(/\/$/, '')}/api/v1/webhooks/pagos` }
        : {}),
    };

    const pref = await this.request<MpPreferenceResponse>('POST', '/checkout/preferences', body);
    // Con access token de test, init_point ya apunta al checkout de prueba.
    const url = pref.init_point || pref.sandbox_init_point;
    if (!url) {
      logger.error({ prefId: pref.id }, 'Mercado Pago: preference sin init_point');
      throw AppError.badRequest('Error de pasarela: preferencia sin URL de pago', 'GATEWAY_ERROR');
    }

    logger.info({ prefId: pref.id, amount, externalReference }, 'Mercado Pago preference creada');
    return { url, externalId: pref.id };
  }

  // ----------------------------------------------------------
  // Verify webhook signature (x-signature + x-request-id + data.id)
  // ----------------------------------------------------------

  verifyWebhook(
    payload: Buffer,
    headers: Record<string, string | string[] | undefined>,
    query?: Record<string, unknown>,
  ): WebhookVerifyResult {
    const secret = env.MERCADOPAGO_WEBHOOK_SECRET;
    if (!secret) {
      logger.error('Mercado Pago: MERCADOPAGO_WEBHOOK_SECRET no configurado — no se puede validar el webhook');
      throw AppError.badRequest('Firma de webhook invalida', 'WEBHOOK_SIGNATURE_INVALID');
    }

    const xSignature = firstHeader(headers['x-signature']);
    const xRequestId = firstHeader(headers['x-request-id']) ?? '';
    if (!xSignature) {
      throw AppError.badRequest('Firma de webhook invalida', 'WEBHOOK_SIGNATURE_INVALID');
    }

    // x-signature: "ts=<millis>,v1=<hash>"
    let ts = '';
    let v1 = '';
    for (const part of xSignature.split(',')) {
      const [k, val] = part.split('=').map((s) => s.trim());
      if (k === 'ts') ts = val;
      else if (k === 'v1') v1 = val;
    }

    // data.id viene del query (?data.id=...) o, en su defecto, del cuerpo.
    let body: { type?: string; action?: string; data?: { id?: string | number } } = {};
    try {
      body = JSON.parse(payload.toString('utf8') || '{}');
    } catch {
      body = {};
    }
    const dataIdRaw =
      (query?.['data.id'] as string | undefined) ??
      (query?.id as string | undefined) ??
      (body.data?.id != null ? String(body.data.id) : undefined);
    const dataId = (dataIdRaw ?? '').toLowerCase(); // MP exige minúsculas si es alfanumérico

    if (!ts || !v1 || !dataId) {
      throw AppError.badRequest('Firma de webhook invalida', 'WEBHOOK_SIGNATURE_INVALID');
    }

    const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
    const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');

    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(v1, 'utf8');
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) {
      logger.warn({ xRequestId, ts }, 'Mercado Pago: firma de webhook inválida — posible manipulación');
      throw AppError.badRequest('Firma de webhook invalida', 'WEBHOOK_SIGNATURE_INVALID');
    }

    return {
      event: body as unknown as Record<string, unknown>,
      type: String(body.type ?? (query?.type as string | undefined) ?? 'payment'),
      eventId: dataIdRaw ?? dataId,
    };
  }

  // ----------------------------------------------------------
  // Get payment status (GET /v1/payments/{id})
  // ----------------------------------------------------------

  async getPaymentStatus(externalId: string): Promise<PaymentStatus> {
    const payment = await this.request<MpPaymentResponse>('GET', `/v1/payments/${externalId}`);
    return {
      status: mapStatus(payment.status),
      transactionRef: String(payment.id),
      rawResponse: payment as unknown as Record<string, unknown>,
    };
  }

  // ----------------------------------------------------------
  // Refund (POST /v1/payments/{id}/refunds)
  // ----------------------------------------------------------

  async refund(transactionRef: string, amount?: number): Promise<RefundResult> {
    const refund = await this.request<{ id: number | string; status?: string }>(
      'POST',
      `/v1/payments/${transactionRef}/refunds`,
      amount ? { amount } : {},
      { 'X-Idempotency-Key': `refund-${transactionRef}-${amount ?? 'full'}` },
    );
    const st = refund.status;
    return {
      refundId: String(refund.id),
      status: st === 'approved' ? 'succeeded' : st === 'in_process' || st === 'pending' ? 'pending' : 'failed',
      rawResponse: refund as unknown as Record<string, unknown>,
    };
  }

  // ----------------------------------------------------------
  // Health check (GET /users/me)
  // ----------------------------------------------------------

  async healthCheck(): Promise<GatewayHealthStatus> {
    try {
      await this.request('GET', '/users/me');
      return { provider: this.provider, connected: true, message: 'Conexion exitosa' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error desconocido';
      return { provider: this.provider, connected: false, message };
    }
  }

  getPublicKey(): string {
    return env.MERCADOPAGO_PUBLIC_KEY;
  }

  // ----------------------------------------------------------
  // HTTP helper (Bearer + timeout + manejo de errores)
  // ----------------------------------------------------------

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MP_TIMEOUT_MS);
    try {
      const res = await fetch(`${MP_API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
          ...extraHeaders,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });

      const text = await res.text();
      let json: unknown = {};
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          if (!res.ok) {
            throw AppError.badRequest(`Error de pasarela: HTTP ${res.status}`, 'GATEWAY_ERROR');
          }
        }
      }

      if (!res.ok) {
        const msg = (json as { message?: string; error?: string })?.message
          ?? (json as { error?: string })?.error
          ?? `HTTP ${res.status}`;
        logger.error({ status: res.status, path, error: json }, 'Mercado Pago: request fallido');
        throw AppError.badRequest(`Error de pasarela: ${msg}`, 'GATEWAY_ERROR');
      }

      return json as T;
    } catch (error) {
      if (error instanceof AppError) throw error;
      const isTimeout = error instanceof Error && error.name === 'AbortError';
      logger.error({ error, path, isTimeout }, 'Mercado Pago: error de red');
      throw AppError.badRequest(
        isTimeout ? `Error de pasarela: timeout de ${MP_TIMEOUT_MS / 1000}s` : 'Error de pasarela: error de red',
        'GATEWAY_ERROR',
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ----------------------------------------------------------
// Helpers
// ----------------------------------------------------------

function firstHeader(h: string | string[] | undefined): string | undefined {
  if (Array.isArray(h)) return h[0];
  return h;
}

function mapStatus(status?: string): PaymentStatus['status'] {
  switch (status) {
    case 'approved':
      return 'completed';
    case 'refunded':
    case 'charged_back':
      return 'refunded';
    case 'cancelled':
      return 'cancelled';
    case 'rejected':
      return 'failed';
    case 'pending':
    case 'in_process':
    case 'in_mediation':
    case 'authorized':
    default:
      return 'pending';
  }
}
