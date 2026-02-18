import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { authMiddleware, authorize, roleGuard } from '@/middleware/auth';
import {
  listInmueblesQuerySchema,
  inmuebleIdParamsSchema,
  createInmuebleSchema,
  updateInmuebleSchema,
  searchInmueblesQuerySchema,
} from './inmuebles.schema';
import * as inmueblesController from './inmuebles.controller';

const router = Router();

router.use(authMiddleware);

router.get(
  '/',
  authorize('inmuebles', 'read'),
  validate({ query: listInmueblesQuerySchema }),
  inmueblesController.list,
);

router.get(
  '/buscar',
  authorize('inmuebles', 'read'),
  validate({ query: searchInmueblesQuerySchema }),
  inmueblesController.search,
);

router.get(
  '/filtros/opciones',
  authorize('inmuebles', 'read'),
  inmueblesController.filterOptions,
);

router.get(
  '/:id',
  authorize('inmuebles', 'read'),
  validate({ params: inmuebleIdParamsSchema }),
  inmueblesController.getById,
);

router.post(
  '/',
  authorize('inmuebles', 'create'),
  validate({ body: createInmuebleSchema }),
  inmueblesController.create,
);

router.patch(
  '/:id',
  authorize('inmuebles', 'update'),
  validate({ params: inmuebleIdParamsSchema, body: updateInmuebleSchema }),
  inmueblesController.update,
);

// RN-006: Solo administrador puede ejecutar la baja logica
router.delete(
  '/:id',
  roleGuard(['administrador']),
  validate({ params: inmuebleIdParamsSchema }),
  inmueblesController.remove,
);

export default router;
