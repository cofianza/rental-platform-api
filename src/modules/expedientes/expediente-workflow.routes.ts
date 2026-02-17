import { Router } from 'express';
import { authMiddleware } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { expedienteIdParamsSchema, transitionBodySchema } from './expediente-workflow.schema';
import * as workflowController from './expediente-workflow.controller';

const router = Router();

// Todas las rutas de workflow requieren autenticacion
router.use(authMiddleware);

// PATCH /api/v1/expedientes/:id/transition
router.patch(
  '/:id/transition',
  validate({ params: expedienteIdParamsSchema, body: transitionBodySchema }),
  workflowController.transition,
);

// GET /api/v1/expedientes/:id/transitions
router.get(
  '/:id/transitions',
  validate({ params: expedienteIdParamsSchema }),
  workflowController.getTransitions,
);

export default router;
