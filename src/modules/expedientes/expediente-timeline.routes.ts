import { Router } from 'express';
import { authMiddleware, roleGuard } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { expedienteIdParamsSchema, timelineQuerySchema } from './expediente-timeline.schema';
import * as timelineController from './expediente-timeline.controller';

const router = Router();

router.use(authMiddleware);
router.use(roleGuard(['administrador', 'operador_analista']));

// GET /api/v1/expedientes/:id/timeline
router.get(
  '/:id/timeline',
  validate({ params: expedienteIdParamsSchema, query: timelineQuerySchema }),
  timelineController.getTimeline,
);

export default router;
