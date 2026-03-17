import { Router, raw } from 'express';
import { authMiddleware, authorize } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import {
  pagoIdParamsSchema,
  createPaymentLinkSchema,
  registerManualPaymentSchema,
  listPagosQuerySchema,
} from './pagos.schema';
import * as pagosController from './pagos.controller';

// ============================================================
// Authenticated pagos routes — /api/v1/pagos
// ============================================================

const pagosRouter = Router();
pagosRouter.use(authMiddleware);

// Specific routes BEFORE :id
pagosRouter.get(
  '/config',
  authorize('pagos', 'read'),
  pagosController.getConfig,
);

pagosRouter.get(
  '/gateway/status',
  authorize('pagos', 'read'),
  pagosController.getGatewayStatus,
);

pagosRouter.post(
  '/payment-link',
  authorize('pagos', 'create'),
  validate({ body: createPaymentLinkSchema }),
  pagosController.createPaymentLink,
);

pagosRouter.post(
  '/manual',
  authorize('pagos', 'create'),
  validate({ body: registerManualPaymentSchema }),
  pagosController.registerManualPayment,
);

// List
pagosRouter.get(
  '/',
  authorize('pagos', 'read'),
  validate({ query: listPagosQuerySchema }),
  pagosController.list,
);

// Detail
pagosRouter.get(
  '/:id',
  authorize('pagos', 'read'),
  validate({ params: pagoIdParamsSchema }),
  pagosController.getById,
);

// Events for a pago
pagosRouter.get(
  '/:id/eventos',
  authorize('pagos', 'read'),
  validate({ params: pagoIdParamsSchema }),
  pagosController.getEventos,
);

// ============================================================
// Stripe webhook — /api/v1/webhooks/stripe
// Needs raw body for signature verification
// ============================================================

const stripeWebhookRouter = Router();
stripeWebhookRouter.post(
  '/',
  raw({ type: 'application/json' }),
  pagosController.handleWebhook,
);

export { pagosRouter, stripeWebhookRouter };
