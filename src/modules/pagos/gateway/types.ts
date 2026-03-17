/**
 * Payment Gateway Adapter — abstract interface.
 * Allows swapping providers (Stripe, MercadoPago, etc.) without changing business logic.
 */

// ============================================================
// Types
// ============================================================

export interface CreatePaymentLinkParams {
  /** Amount in COP (no decimals) */
  amount: number;
  /** Short concept for the payment */
  concept: string;
  /** Longer description shown to the payer */
  description: string;
  /** Metadata to attach (expediente_id, pago_id, etc.) */
  metadata: Record<string, string>;
  /** URL to redirect on success */
  successUrl: string;
  /** URL to redirect on cancel */
  cancelUrl: string;
}

export interface PaymentLinkResult {
  /** URL the user visits to pay */
  url: string;
  /** Provider's session/checkout ID */
  externalId: string;
}

export interface PaymentStatus {
  /** Current status from the provider */
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'refunded' | 'cancelled';
  /** Provider's transaction reference (e.g. Stripe PaymentIntent ID) */
  transactionRef: string | null;
  /** Full provider response for storage */
  rawResponse: Record<string, unknown>;
}

export interface RefundResult {
  /** Provider's refund ID */
  refundId: string;
  status: 'succeeded' | 'pending' | 'failed';
  rawResponse: Record<string, unknown>;
}

export interface WebhookVerifyResult {
  /** Raw parsed event from the provider */
  event: Record<string, unknown>;
  /** Event type string (e.g. 'checkout.session.completed') */
  type: string;
}

export interface GatewayHealthStatus {
  provider: string;
  connected: boolean;
  message: string;
}

// ============================================================
// Adapter interface
// ============================================================

export interface PaymentGatewayAdapter {
  /** Provider name (e.g. 'stripe') */
  readonly provider: string;

  /** Create a payment link / checkout session */
  createPaymentLink(params: CreatePaymentLinkParams): Promise<PaymentLinkResult>;

  /** Verify webhook signature and parse event */
  verifyWebhook(payload: Buffer, signature: string): WebhookVerifyResult;

  /** Query the current status of a payment by external ID */
  getPaymentStatus(externalId: string): Promise<PaymentStatus>;

  /** Process a full refund */
  refund(transactionRef: string, amount?: number): Promise<RefundResult>;

  /** Health check — verify connectivity with the provider */
  healthCheck(): Promise<GatewayHealthStatus>;

  /** Return the publishable/public key for the frontend */
  getPublicKey(): string;
}
