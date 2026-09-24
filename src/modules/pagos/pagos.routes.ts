import { Router, raw } from 'express';
import { authMiddleware, authorize, roleGuard } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import {
  pagoIdParamsSchema,
  expedienteIdParamsSchema,
  createPaymentLinkSchema,
  registerManualPaymentSchema,
  comprobantePresignedUrlSchema,
  listPagosQuerySchema,
  reembolsoIdParamsSchema,
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

// Enlaces de cobro genéricos, cancelar y reenviar: solo el equipo de Cofianza,
// como en la web (PagosSection, canManage). Aquí el monto, el concepto y el
// correo los pone quien llama, y el cobro pagado se factura solo ante la DIAN;
// la inmobiliaria y el propietario cobran la evaluación por /pago-estudio/*.
// Cancelar y reenviar pedían 'pagos','update', que el operador no tiene: la web
// le mostraba los botones y respondía 403.
const ROLES_COBRO = ['administrador', 'operador_analista'];

// GET /expedientes/:expedienteId/pagos/prima-sugerida — la prima con IVA que
// los modales de cobro sugieren para la garantía (Adenda 1 de contratos §1.1).
expedientePagosRouter.get(
  '/prima-sugerida',
  authorize('pagos', 'read'),
  roleGuard(ROLES_COBRO),
  validate({ params: expedienteIdParamsSchema }),
  pagosController.getPrimaSugerida,
);

// POST /expedientes/:expedienteId/pagos — Create payment link
expedientePagosRouter.post(
  '/',
  authorize('pagos', 'create'),
  roleGuard(ROLES_COBRO),
  validate({ params: expedienteIdParamsSchema, body: createPaymentLinkSchema }),
  pagosController.createPaymentLink,
);

// POST /expedientes/:expedienteId/pagos/manual — Register manual payment (HP-350)
//
// roleGuard: registrar un pago manual (con comprobante) es una accion de
// gestor, nunca del pagador — es exactamente lo que la web ya asume
// (PagosSection solo muestra "Registrar Pago Manual" a admin/operador). Sin
// esto, `authorize('pagos','create')` dejaba pasar al rol 'solicitante', que
// desde el §6.3 podia insertarse a si mismo un pago 'estudio' 'completado' por
// $1: esa fila ES la señal que lee el gate de ejecucion, y ademas dispara
// onEstudioPagado -> consulta FACTURABLE al buro.
expedientePagosRouter.post(
  '/manual',
  authorize('pagos', 'create'),
  roleGuard(ROLES_COBRO),
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

// P1: cola de reembolsos de Mercado Pago (evaluaciones de estudios que
// terminaron sin consulta al buró y pagos que entraron sin cobro). Devolver
// plata es una decisión de Cofianza: solo administradores.
pagosRouter.get('/reembolsos', roleGuard(['administrador']), pagosController.listReembolsos);
pagosRouter.post(
  '/reembolsos/:id/reembolsar',
  roleGuard(['administrador']),
  validate({ params: reembolsoIdParamsSchema }),
  pagosController.reembolsar,
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
  roleGuard(ROLES_COBRO),
  validate({ params: pagoIdParamsSchema }),
  pagosController.cancel,
);

// POST /pagos/:pagoId/reenviar-link — Resend payment link email
pagosRouter.post(
  '/:pagoId/reenviar-link',
  roleGuard(ROLES_COBRO),
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
