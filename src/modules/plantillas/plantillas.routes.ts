import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { authMiddleware, authorize } from '@/middleware/auth';
import {
  plantillaIdParamsSchema,
  createPlantillaSchema,
  updatePlantillaSchema,
  listPlantillasQuerySchema,
  previewPlantillaSchema,
} from './plantillas.schema';
import * as plantillasController from './plantillas.controller';

const router = Router();

router.use(authMiddleware);

// GET / — List paginated
router.get(
  '/',
  authorize('plantillas', 'read'),
  validate({ query: listPlantillasQuerySchema }),
  plantillasController.list,
);

// POST / — Create
router.post(
  '/',
  authorize('plantillas', 'create'),
  validate({ body: createPlantillaSchema }),
  plantillasController.create,
);

// GET /:id — Get by ID
router.get(
  '/:id',
  authorize('plantillas', 'read'),
  validate({ params: plantillaIdParamsSchema }),
  plantillasController.getById,
);

// PATCH /:id — Update
router.patch(
  '/:id',
  authorize('plantillas', 'update'),
  validate({ params: plantillaIdParamsSchema, body: updatePlantillaSchema }),
  plantillasController.update,
);

// DELETE /:id — Soft delete
router.delete(
  '/:id',
  authorize('plantillas', 'delete'),
  validate({ params: plantillaIdParamsSchema }),
  plantillasController.remove,
);

// POST /:id/preview — Compile with sample data
router.post(
  '/:id/preview',
  authorize('plantillas', 'read'),
  validate({ params: plantillaIdParamsSchema, body: previewPlantillaSchema }),
  plantillasController.preview,
);

export default router;
