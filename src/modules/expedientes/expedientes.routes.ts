import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { authMiddleware, authorize, roleGuard } from '@/middleware/auth';
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

// GET /check-inmueble/:inmuebleId — HP-247: Verificar si inmueble tiene expediente activo
router.get(
  '/check-inmueble/:inmuebleId',
  authorize('expedientes', 'read'),
  expedientesController.checkByInmueble,
);

// GET /mi-expediente-por-inmueble/:inmuebleId — flujo "Me interesa" del solicitante.
// Filtra por solicitantes.creado_por = req.user.id (privacy + UX correctos).
// Solo rol solicitante: admin/operador usan check-inmueble.
router.get(
  '/mi-expediente-por-inmueble/:inmuebleId',
  roleGuard(['solicitante']),
  expedientesController.miExpedientePorInmueble,
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
