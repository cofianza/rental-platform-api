import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { authMiddleware, authorize } from '@/middleware/auth';
import {
  expedienteIdParamsSchema,
  createExpedienteSchema,
  updateExpedienteSchema,
  listExpedientesQuerySchema,
} from './expedientes.schema';
import * as expedientesController from './expedientes.controller';

const router = Router();

// Todas las rutas requieren autenticacion JWT
router.use(authMiddleware);

// GET /stats — Estadisticas por estado (ANTES de /:id)
router.get(
  '/stats',
  authorize('expedientes', 'read'),
  expedientesController.stats,
);

// GET / — Listar con paginacion, filtros y busqueda
router.get(
  '/',
  authorize('expedientes', 'read'),
  validate({ query: listExpedientesQuerySchema }),
  expedientesController.list,
);

// GET /:id — Detalle con relaciones
router.get(
  '/:id',
  authorize('expedientes', 'read'),
  validate({ params: expedienteIdParamsSchema }),
  expedientesController.getById,
);

// POST / — Crear expediente
router.post(
  '/',
  authorize('expedientes', 'create'),
  validate({ body: createExpedienteSchema }),
  expedientesController.create,
);

// PATCH /:id — Actualizar (notas, analista, codeudor)
router.patch(
  '/:id',
  authorize('expedientes', 'update'),
  validate({ params: expedienteIdParamsSchema, body: updateExpedienteSchema }),
  expedientesController.update,
);

export default router;
