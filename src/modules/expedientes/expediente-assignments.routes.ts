import { Router } from 'express';
import { authMiddleware, roleGuard } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { expedienteIdParamsSchema, assignBodySchema } from './expediente-assignments.schema';
import * as assignmentsController from './expediente-assignments.controller';

const router = Router();

// roleGuard va POR-RUTA para no bloquear requests que atraviesan este
// router rumbo a otros routers mounted en /api/v1/expedientes.
router.use(authMiddleware);

const assignmentsRoleGuard = roleGuard(['administrador', 'operador_analista']);

// POST /api/v1/expedientes/:id/assignments — Assign/reassign responsable
router.post(
  '/:id/assignments',
  assignmentsRoleGuard,
  validate({ params: expedienteIdParamsSchema, body: assignBodySchema }),
  assignmentsController.assign,
);

// GET /api/v1/expedientes/:id/assignments — Assignment history
router.get(
  '/:id/assignments',
  assignmentsRoleGuard,
  validate({ params: expedienteIdParamsSchema }),
  assignmentsController.history,
);

export default router;
