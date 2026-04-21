import { Router } from 'express';
import { authMiddleware, roleGuard } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { expedienteIdParamsSchema, timelineQuerySchema } from './expediente-timeline.schema';
import * as timelineController from './expediente-timeline.controller';

const router = Router();

// roleGuard va POR-RUTA para no bloquear requests que atraviesan este
// router rumbo a otros routers mounted en /api/v1/expedientes.
router.use(authMiddleware);

// GET /api/v1/expedientes/:id/timeline
router.get(
  '/:id/timeline',
  roleGuard(['administrador', 'operador_analista']),
  validate({ params: expedienteIdParamsSchema, query: timelineQuerySchema }),
  timelineController.getTimeline,
);

export default router;
