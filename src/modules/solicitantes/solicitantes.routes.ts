import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { authMiddleware, authorize, roleGuard } from '@/middleware/auth';
import {
  applicantIdParamsSchema,
  createApplicantSchema,
  updateApplicantSchema,
  listApplicantsQuerySchema,
  searchByDocumentQuerySchema,
} from './solicitantes.schema';
import * as solicitantesController from './solicitantes.controller';

const router = Router();

// Todas las rutas requieren autenticacion JWT
router.use(authMiddleware);

// GET /search — Buscar por tipo + numero de documento (ANTES de /:id)
router.get(
  '/search',
  authorize('solicitantes', 'read'),
  validate({ query: searchByDocumentQuerySchema }),
  solicitantesController.searchByDocument,
);

// GET / — Listar con paginacion y busqueda
router.get(
  '/',
  authorize('solicitantes', 'read'),
  validate({ query: listApplicantsQuerySchema }),
  solicitantesController.list,
);

// GET /:id — Obtener detalle por ID
router.get(
  '/:id',
  authorize('solicitantes', 'read'),
  validate({ params: applicantIdParamsSchema }),
  solicitantesController.getById,
);

// POST / — Crear nuevo solicitante
router.post(
  '/',
  authorize('solicitantes', 'create'),
  validate({ body: createApplicantSchema }),
  solicitantesController.create,
);

// PATCH /:id — Actualizar solicitante (parcial)
router.patch(
  '/:id',
  authorize('solicitantes', 'update'),
  validate({ params: applicantIdParamsSchema, body: updateApplicantSchema }),
  solicitantesController.update,
);

// DELETE /:id — Desactivar solicitante (solo administrador)
router.delete(
  '/:id',
  roleGuard(['administrador']),
  validate({ params: applicantIdParamsSchema }),
  solicitantesController.deactivate,
);

export default router;
