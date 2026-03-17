import { env } from '@/config';
import { StripeAdapter } from './stripe.adapter';
import type { PaymentGatewayAdapter } from './types';

export type { PaymentGatewayAdapter } from './types';
export type {
  CreatePaymentLinkParams,
  PaymentLinkResult,
  PaymentStatus,
  RefundResult,
  WebhookVerifyResult,
  GatewayHealthStatus,
} from './types';

// ============================================================
// Factory — selects the active adapter from env var
// ============================================================

let _gateway: PaymentGatewayAdapter | null = null;

export function getPaymentGateway(): PaymentGatewayAdapter {
  if (!_gateway) {
    switch (env.PAYMENT_GATEWAY_PROVIDER) {
      case 'stripe':
        _gateway = new StripeAdapter();
        break;
      default:
        throw new Error(`Payment gateway provider '${env.PAYMENT_GATEWAY_PROVIDER}' not supported`);
    }
  }
  return _gateway;
}
