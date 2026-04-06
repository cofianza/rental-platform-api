// ============================================================
// Export — Routes (HP-364)
// ============================================================

import { Router } from 'express';
import { authMiddleware, authorize, roleGuard } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { exportQuerySchema } from './export.schema';
import * as controller from './export.controller';

const router = Router();

router.use(authMiddleware);

const v = validate({ query: exportQuerySchema });

// Expedientes & Inmuebles: admin + operador
router.get('/expedientes', authorize('expedientes', 'read'), v, controller.exportExpedientes);
router.get('/inmuebles', authorize('inmuebles', 'read'), v, controller.exportInmuebles);

// Reportes: admin + operador + gerencia (via reportes:read)
router.get('/reportes/volumen', authorize('reportes', 'read'), v, controller.exportVolumen);
router.get('/reportes/aprobacion', authorize('reportes', 'read'), v, controller.exportAprobacion);
router.get('/reportes/tiempos', authorize('reportes', 'read'), v, controller.exportTiempos);

// Ingresos: admin + gerencia only (financial data)
router.get('/reportes/ingresos', authorize('reportes', 'read'), roleGuard(['administrador', 'gerencia_consulta']), v, controller.exportIngresos);

export default router;
