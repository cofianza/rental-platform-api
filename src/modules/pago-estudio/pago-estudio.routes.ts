import { Router } from 'express';
import { authMiddleware, authorize } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { expedienteIdParamsSchema, enviarLinkSchema, pagoIdParamsSchema } from './pago-estudio.schema';
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

pagoEstudioRouter.post(
  '/reenviar',
  authorize('pagos', 'update'),
  validate({ params: expedienteIdParamsSchema }),
  controller.reenviar,
);

pagoEstudioRouter.post(
  '/cancelar-y-asumir',
  authorize('pagos', 'update'),
  validate({ params: expedienteIdParamsSchema }),
  controller.cancelarYAsumir,
);

// ============================================================
// Public — /api/v1/publico/pago-resultado/:pagoId
// ============================================================

const publicPagoResultadoRouter = Router();

publicPagoResultadoRouter.get(
  '/:pagoId',
  validate({ params: pagoIdParamsSchema }),
  controller.resultadoPublico,
);

export { pagoEstudioRouter, publicPagoResultadoRouter };
