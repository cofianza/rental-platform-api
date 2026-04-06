// ============================================================
// Reportes — Routes (HP-360)
// ============================================================

import { Router } from 'express';
import { authMiddleware, authorize, roleGuard } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { volumenQuerySchema, aprobacionQuerySchema, ingresosQuerySchema, tiemposQuerySchema } from './reportes.schema';
import * as controller from './reportes.controller';

const router = Router();

// All reportes routes require auth + reportes:read permission
router.use(authMiddleware);
router.use(authorize('reportes', 'read'));

router.get(
  '/volumen-expedientes',
  validate({ query: volumenQuerySchema }),
  controller.getVolumenExpedientes,
);

// HP-361
router.get(
  '/aprobacion',
  validate({ query: aprobacionQuerySchema }),
  controller.getAprobacionExpedientes,
);

// HP-362: Ingresos — restricted to administrador + gerencia_consulta only
router.get(
  '/ingresos',
  roleGuard(['administrador', 'gerencia_consulta']),
  validate({ query: ingresosQuerySchema }),
  controller.getIngresosReporte,
);

// HP-363: Tiempos por etapa
router.get(
  '/tiempos-por-etapa',
  validate({ query: tiemposQuerySchema }),
  controller.getTiemposPorEtapa,
);

export default router;
