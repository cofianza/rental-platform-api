// ============================================================
// Dashboard — Routes (HP-358)
// ============================================================

import { Router } from 'express';
import { authMiddleware, authorize, roleGuard } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { dashboardQuerySchema } from './dashboard.schema';
import * as controller from './dashboard.controller';

const router = Router();

// Todas las rutas de dashboard requieren auth
router.use(authMiddleware);

// Portfolio stats — disponible para propietario/inmobiliaria (su propio
// portafolio) y admin/operador (con su propio user.id como propietario, lo
// que da 0 a menos que el admin sea tambien propietario; el caso de admin
// viendo portfolio ajeno no aplica al hero del dashboard).
router.get(
  '/portfolio-stats',
  roleGuard(['propietario', 'inmobiliaria', 'administrador', 'operador_analista']),
  controller.getPortfolioStats,
);

// Resto: solo roles con permiso dashboard:read (admin/operador/gerencia)
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
