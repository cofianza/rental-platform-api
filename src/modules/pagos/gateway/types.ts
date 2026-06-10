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
  /** URL to redirect when the payment stays pending (PSE/efectivo). Falls back to successUrl. */
  pendingUrl?: string;
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
  /** Unique event ID from the provider (for idempotency) */
  eventId: string;
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

  /**
   * Verify webhook signature and parse event.
   * Recibe los headers (cada proveedor usa los suyos: Stripe `stripe-signature`;
   * Mercado Pago `x-signature` + `x-request-id`) y el query (MP toma `data.id` de ahí).
   */
  verifyWebhook(
    payload: Buffer,
    headers: Record<string, string | string[] | undefined>,
    query?: Record<string, unknown>,
  ): WebhookVerifyResult;

  /** Query the current status of a payment by external ID */
  getPaymentStatus(externalId: string): Promise<PaymentStatus>;

  /**
   * Invalidate a payment link so it can no longer be paid (e.g. after the pago
   * was cancelled in our DB). Optional: providers that can't expire links may
   * omit it. Callers must treat it as best-effort.
   */
  cancelPaymentLink?(externalId: string): Promise<void>;

  /**
   * Search payments by our external reference (used by the periodic
   * reconciliation job when we never got a webhook). Optional per provider.
   */
  searchPaymentsByReference?(externalReference: string): Promise<PaymentStatus[]>;

  /** Process a full refund */
  refund(transactionRef: string, amount?: number): Promise<RefundResult>;

  /** Health check — verify connectivity with the provider */
  healthCheck(): Promise<GatewayHealthStatus>;

  /** Return the publishable/public key for the frontend */
  getPublicKey(): string;
}
