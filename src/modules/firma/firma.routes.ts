import { Router } from 'express';
import { authMiddleware, roleGuard, authorize } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import {
  crearSolicitudFirmaSchema,
  solicitudIdParamsSchema,
  contratoIdParamsSchema,
  tokenParamsSchema,
} from './firma.schema';
import * as firmaController from './firma.controller';

// ============================================================
// Authenticated routes: /api/v1/firma/solicitudes
// ============================================================

export const firmaRouter = Router();
firmaRouter.use(authMiddleware);

// POST / — Create solicitud and send link
firmaRouter.post(
  '/',
  roleGuard(['administrador', 'operador_analista']),
  validate({ body: crearSolicitudFirmaSchema }),
  firmaController.crear,
);

// GET /:id — Get solicitud detail
firmaRouter.get(
  '/:id',
  authorize('contratos', 'read'),
  validate({ params: solicitudIdParamsSchema }),
  firmaController.getById,
);

// POST /:id/reenviar — Resend link (new token)
firmaRouter.post(
  '/:id/reenviar',
  roleGuard(['administrador', 'operador_analista']),
  validate({ params: solicitudIdParamsSchema }),
  firmaController.reenviar,
);

// POST /:id/cancelar — Cancel solicitud
firmaRouter.post(
  '/:id/cancelar',
  roleGuard(['administrador', 'operador_analista']),
  validate({ params: solicitudIdParamsSchema }),
  firmaController.cancelar,
);

// ============================================================
// Contract-scoped routes: /api/v1/contratos/:contratoId/firma/solicitudes
// ============================================================

export const contratoFirmaSolicitudesRouter = Router({ mergeParams: true });
contratoFirmaSolicitudesRouter.use(authMiddleware);

// GET / — List solicitudes for contrato
contratoFirmaSolicitudesRouter.get(
  '/',
  authorize('contratos', 'read'),
  validate({ params: contratoIdParamsSchema }),
  firmaController.listarPorContrato,
);

// ============================================================
// Public routes: /api/v1/public/firma
// ============================================================

export const publicFirmaRouter = Router();

// GET /:token — Validate token and get info (public, no auth)
publicFirmaRouter.get(
  '/:token',
  validate({ params: tokenParamsSchema }),
  firmaController.validarToken,
);

// ============================================================
// Auco webhook: /api/v1/webhooks/auco/firma
// ============================================================

export const aucoWebhookRouter = Router();

// POST / — Receive Auco signature status notifications (no auth — validated via secret)
aucoWebhookRouter.post('/', firmaController.aucoWebhook);
