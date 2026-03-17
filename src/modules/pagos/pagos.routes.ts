import { Router, raw } from 'express';
import { authMiddleware, authorize } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import {
  pagoIdParamsSchema,
  expedienteIdParamsSchema,
  createPaymentLinkSchema,
  registerManualPaymentSchema,
  comprobantePresignedUrlSchema,
  listPagosQuerySchema,
} from './pagos.schema';
import * as pagosController from './pagos.controller';

// ============================================================
// Expediente-scoped pagos — /api/v1/expedientes/:expedienteId/pagos
// ============================================================

const expedientePagosRouter = Router({ mergeParams: true });
expedientePagosRouter.use(authMiddleware);

// GET /expedientes/:expedienteId/pagos — List pagos for an expediente
expedientePagosRouter.get(
  '/',
  authorize('pagos', 'read'),
  validate({ params: expedienteIdParamsSchema, query: listPagosQuerySchema }),
  pagosController.listByExpediente,
);

// POST /expedientes/:expedienteId/pagos — Create payment link
expedientePagosRouter.post(
  '/',
  authorize('pagos', 'create'),
  validate({ params: expedienteIdParamsSchema, body: createPaymentLinkSchema }),
  pagosController.createPaymentLink,
);

// POST /expedientes/:expedienteId/pagos/manual — Register manual payment (HP-350)
expedientePagosRouter.post(
  '/manual',
  authorize('pagos', 'create'),
  validate({ params: expedienteIdParamsSchema, body: registerManualPaymentSchema }),
  pagosController.registerManualPayment,
);

// ============================================================
// Pagos routes — /api/v1/pagos
// ============================================================

const pagosRouter = Router();
pagosRouter.use(authMiddleware);

// Specific routes BEFORE :pagoId
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

// POST /pagos/comprobante/presigned-url — Get presigned URL for comprobante upload (HP-350)
pagosRouter.post(
  '/comprobante/presigned-url',
  authorize('pagos', 'create'),
  validate({ body: comprobantePresignedUrlSchema }),
  pagosController.comprobantePresignedUrl,
);

// GET /pagos/:pagoId — Detail with events
pagosRouter.get(
  '/:pagoId',
  authorize('pagos', 'read'),
  validate({ params: pagoIdParamsSchema }),
  pagosController.getById,
);

// PATCH /pagos/:pagoId/cancelar — Cancel pending payment
pagosRouter.patch(
  '/:pagoId/cancelar',
  authorize('pagos', 'update'),
  validate({ params: pagoIdParamsSchema }),
  pagosController.cancel,
);

// POST /pagos/:pagoId/reenviar-link — Resend payment link email
pagosRouter.post(
  '/:pagoId/reenviar-link',
  authorize('pagos', 'update'),
  validate({ params: pagoIdParamsSchema }),
  pagosController.resendLink,
);

// GET /pagos/:pagoId/comprobante — Download comprobante (HP-350)
pagosRouter.get(
  '/:pagoId/comprobante',
  authorize('pagos', 'read'),
  validate({ params: pagoIdParamsSchema }),
  pagosController.getComprobante,
);

// GET /pagos/:pagoId/eventos — Full event history (HP-352)
pagosRouter.get(
  '/:pagoId/eventos',
  authorize('pagos', 'read'),
  validate({ params: pagoIdParamsSchema }),
  pagosController.getEventos,
);

// GET /pagos/:pagoId/estado — Current state + last transition metadata (HP-352)
pagosRouter.get(
  '/:pagoId/estado',
  authorize('pagos', 'read'),
  validate({ params: pagoIdParamsSchema }),
  pagosController.getEstado,
);

// ============================================================
// Payment webhook — /api/v1/webhooks/pagos
// Needs raw body for HMAC signature verification. No JWT auth.
// ============================================================

const pagosWebhookRouter = Router();
pagosWebhookRouter.post(
  '/',
  raw({ type: 'application/json' }),
  pagosController.handleWebhook,
);

// ============================================================
// DEV ONLY — Simulate webhook for local testing
// ============================================================

const devWebhookRouter = Router();
devWebhookRouter.post(
  '/simulate',
  pagosController.simulateWebhook,
);

export { expedientePagosRouter, pagosRouter, pagosWebhookRouter, devWebhookRouter };
