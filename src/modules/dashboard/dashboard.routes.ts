// ============================================================
// Dashboard — Routes (HP-358)
// ============================================================

import { Router } from 'express';
import { authMiddleware, authorize } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { dashboardQuerySchema } from './dashboard.schema';
import * as controller from './dashboard.controller';

const router = Router();

// All dashboard routes require auth + dashboard:read permission
router.use(authMiddleware);
router.use(authorize('dashboard', 'read'));

router.get(
  '/summary',
  validate({ query: dashboardQuerySchema }),
  controller.getSummary,
);

router.get(
  '/expedientes-por-estado',
  validate({ query: dashboardQuerySchema }),
  controller.getExpedientesPorEstado,
);

export default router;
