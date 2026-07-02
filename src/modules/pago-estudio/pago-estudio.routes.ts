import { Router } from 'express';
import { authMiddleware, authorize } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { expedienteIdParamsSchema, enviarLinkSchema, reenviarLinkSchema, pagoIdParamsSchema, reconciliarSchema } from './pago-estudio.schema';
import * as controller from './pago-estudio.controller';

// ============================================================
// Authenticated — /api/v1/expedientes/:expedienteId/pago-estudio
// ============================================================

const pagoEstudioRouter = Router({ mergeParams: true });
pagoEstudioRouter.use(authMiddleware);

pagoEstudioRouter.get(
  '/estado',
  authorize('pagos', 'read'),
  validate({ params: expedienteIdParamsSchema }),
  controller.getEstado,
);

pagoEstudioRouter.post(
  '/asumir',
  authorize('pagos', 'create'),
  validate({ params: expedienteIdParamsSchema }),
  controller.asumir,
);

pagoEstudioRouter.post(
  '/enviar-link',
  authorize('pagos', 'create'),
  validate({ params: expedienteIdParamsSchema, body: enviarLinkSchema }),
  controller.enviarLink,
);

// Body opcional { email_pagador?, nombre_pagador? } para corregir el destino
// si el email quedó mal escrito (no se puede re-crear el link: hay un pago
// pendiente activo que bloquea /enviar-link con 409).
pagoEstudioRouter.post(
  '/reenviar',
  authorize('pagos', 'update'),
  validate({ params: expedienteIdParamsSchema, body: reenviarLinkSchema }),
  controller.reenviar,
);

pagoEstudioRouter.post(
  '/cancelar-y-asumir',
  authorize('pagos', 'update'),
  validate({ params: expedienteIdParamsSchema }),
  controller.cancelarYAsumir,
);

pagoEstudioRouter.post(
  '/cancelar-y-liberar-credito',
  authorize('pagos', 'update'),
  validate({ params: expedienteIdParamsSchema }),
  controller.cancelarYLiberarCredito,
);

// ============================================================
// Public — /api/v1/publico/pago-resultado/:pagoId
// ============================================================

const publicPagoResultadoRouter = Router();

publicPagoResultadoRouter.post(
  '/reconciliar',
  validate({ body: reconciliarSchema }),
  controller.reconciliarPublico,
);

publicPagoResultadoRouter.get(
  '/:pagoId',
  validate({ params: pagoIdParamsSchema }),
  controller.resultadoPublico,
);

export { pagoEstudioRouter, publicPagoResultadoRouter };
