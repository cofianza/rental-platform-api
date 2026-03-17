import Stripe from 'stripe';
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
// Stripe Adapter
// ============================================================

export class StripeAdapter implements PaymentGatewayAdapter {
  readonly provider = 'stripe';
  private stripe: Stripe;

  constructor() {
    this.stripe = new Stripe(env.STRIPE_SECRET_KEY, {
      apiVersion: '2026-02-25.clover',
    });
  }

  // ----------------------------------------------------------
  // Create payment link (Checkout Session)
  // ----------------------------------------------------------

  async createPaymentLink(params: CreatePaymentLinkParams): Promise<PaymentLinkResult> {
    const { amount, concept, description, metadata, successUrl, cancelUrl } = params;

    // Stripe expects amounts in the smallest currency unit.
    // COP has no decimal sub-units, so 1 COP = 100 centavos in Stripe.
    const amountInCentavos = amount * 100;

    try {
      const session = await this.stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: 'cop',
              unit_amount: amountInCentavos,
              product_data: {
                name: concept,
                description,
              },
            },
            quantity: 1,
          },
        ],
        metadata,
        success_url: successUrl,
        cancel_url: cancelUrl,
      });

      logger.info({ sessionId: session.id, amount }, 'Stripe checkout session created');

      return {
        url: session.url!,
        externalId: session.id,
      };
    } catch (error) {
      logger.error({ error, params: { amount, concept } }, 'Stripe createPaymentLink failed');
      if (error instanceof Stripe.errors.StripeError) {
        throw AppError.badRequest(`Error de pasarela: ${error.message}`, 'GATEWAY_ERROR');
      }
      throw error;
    }
  }

  // ----------------------------------------------------------
  // Verify webhook signature
  // ----------------------------------------------------------

  verifyWebhook(payload: Buffer, signature: string): WebhookVerifyResult {
    try {
      const event = this.stripe.webhooks.constructEvent(
        payload,
        signature,
        env.STRIPE_WEBHOOK_SECRET,
      );

      return {
        event: event as unknown as Record<string, unknown>,
        type: event.type,
      };
    } catch (error) {
      logger.warn({ error }, 'Stripe webhook signature verification failed');
      throw AppError.badRequest('Firma de webhook invalida', 'WEBHOOK_SIGNATURE_INVALID');
    }
  }

  // ----------------------------------------------------------
  // Get payment status
  // ----------------------------------------------------------

  async getPaymentStatus(externalId: string): Promise<PaymentStatus> {
    try {
      const session = await this.stripe.checkout.sessions.retrieve(externalId, {
        expand: ['payment_intent'],
      });

      const paymentIntent = session.payment_intent as Stripe.PaymentIntent | null;

      return {
        status: this.mapSessionStatus(session.status, paymentIntent?.status),
        transactionRef: paymentIntent?.id ?? null,
        rawResponse: session as unknown as Record<string, unknown>,
      };
    } catch (error) {
      logger.error({ error, externalId }, 'Stripe getPaymentStatus failed');
      if (error instanceof Stripe.errors.StripeError) {
        throw AppError.badRequest(`Error de pasarela: ${error.message}`, 'GATEWAY_ERROR');
      }
      throw error;
    }
  }

  // ----------------------------------------------------------
  // Refund
  // ----------------------------------------------------------

  async refund(transactionRef: string, amount?: number): Promise<RefundResult> {
    try {
      const refundParams: Stripe.RefundCreateParams = {
        payment_intent: transactionRef,
      };

      if (amount) {
        refundParams.amount = amount * 100; // COP → centavos
      }

      const refund = await this.stripe.refunds.create(refundParams);

      logger.info({ refundId: refund.id, transactionRef, amount }, 'Stripe refund created');

      return {
        refundId: refund.id,
        status: refund.status === 'succeeded' ? 'succeeded' : refund.status === 'pending' ? 'pending' : 'failed',
        rawResponse: refund as unknown as Record<string, unknown>,
      };
    } catch (error) {
      logger.error({ error, transactionRef }, 'Stripe refund failed');
      if (error instanceof Stripe.errors.StripeError) {
        throw AppError.badRequest(`Error de reembolso: ${error.message}`, 'REFUND_ERROR');
      }
      throw error;
    }
  }

  // ----------------------------------------------------------
  // Health check
  // ----------------------------------------------------------

  async healthCheck(): Promise<GatewayHealthStatus> {
    try {
      await this.stripe.balance.retrieve();
      return { provider: 'stripe', connected: true, message: 'Conexion exitosa' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error desconocido';
      return { provider: 'stripe', connected: false, message };
    }
  }

  // ----------------------------------------------------------
  // Public key
  // ----------------------------------------------------------

  getPublicKey(): string {
    return env.STRIPE_PUBLISHABLE_KEY;
  }

  // ----------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------

  private mapSessionStatus(
    sessionStatus: string | null,
    intentStatus?: string | null,
  ): PaymentStatus['status'] {
    if (sessionStatus === 'complete') {
      if (intentStatus === 'succeeded') return 'completed';
      if (intentStatus === 'processing') return 'processing';
      return 'completed';
    }
    if (sessionStatus === 'expired') return 'cancelled';
    if (intentStatus === 'requires_payment_method' || intentStatus === 'canceled') return 'failed';
    return 'pending';
  }
}
