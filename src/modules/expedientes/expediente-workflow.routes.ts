import { Router } from 'express';
import { authMiddleware, authorize, roleGuard } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { expedienteIdParamsSchema, transitionBodySchema } from './expediente-workflow.schema';
import * as workflowController from './expediente-workflow.controller';

const router = Router();

// Todas las rutas de workflow requieren autenticacion
router.use(authMiddleware);

// POST /api/v1/expedientes/:id/transitions — Ejecutar transicion
router.post(
  '/:id/transitions',
  roleGuard(['administrador', 'operador_analista']),
  validate({ params: expedienteIdParamsSchema, body: transitionBodySchema }),
  workflowController.transition,
);

// GET /api/v1/expedientes/:id/available-transitions — Transiciones disponibles
router.get(
  '/:id/available-transitions',
  authorize('expedientes', 'read'),
  validate({ params: expedienteIdParamsSchema }),
  workflowController.getAvailableTransitions,
);

// GET /api/v1/expedientes/:id/transitions — Historial de transiciones
router.get(
  '/:id/transitions',
  authorize('expedientes', 'read'),
  validate({ params: expedienteIdParamsSchema }),
  workflowController.getHistory,
);

export default router;
