import { Router } from 'express';
import { authMiddleware, roleGuard } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { expedienteIdParamsSchema, assignBodySchema } from './expediente-assignments.schema';
import * as assignmentsController from './expediente-assignments.controller';

const router = Router();

router.use(authMiddleware);
router.use(roleGuard(['administrador', 'operador_analista']));

// POST /api/v1/expedientes/:id/assignments — Assign/reassign responsable
router.post(
  '/:id/assignments',
  validate({ params: expedienteIdParamsSchema, body: assignBodySchema }),
  assignmentsController.assign,
);

// GET /api/v1/expedientes/:id/assignments — Assignment history
router.get(
  '/:id/assignments',
  validate({ params: expedienteIdParamsSchema }),
  assignmentsController.history,
);

export default router;
