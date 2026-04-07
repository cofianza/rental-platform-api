import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { authMiddleware, authorize, roleGuard } from '@/middleware/auth';
import {
  listInmueblesQuerySchema,
  inmuebleIdParamsSchema,
  createInmuebleSchema,
  updateInmuebleSchema,
  searchInmueblesQuerySchema,
  listCambiosQuerySchema,
  visibilitySchema,
} from './inmuebles.schema';
import {
  inmuebleIdOnlyParamsSchema,
  fotoIdParamsSchema,
  createFotoSchema,
  updateFotoSchema,
  reordenarFotosSchema,
} from './inmuebles-fotos.schema';
import * as inmueblesController from './inmuebles.controller';
import * as fotosController from './inmuebles-fotos.controller';

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

router.get(
  '/:id/cambios',
  authorize('inmuebles', 'read'),
  validate({ params: inmuebleIdParamsSchema, query: listCambiosQuerySchema }),
  inmueblesController.listCambios,
);

router.get(
  '/:id/cambios/resumen',
  authorize('inmuebles', 'read'),
  validate({ params: inmuebleIdParamsSchema }),
  inmueblesController.getCambiosResumen,
);

router.post(
  '/',
  authorize('inmuebles', 'create'),
  validate({ body: createInmuebleSchema }),
  inmueblesController.create,
);

// Upload fachada image via backend (avoids Supabase Storage auth issues on frontend)
router.post(
  '/upload-fachada',
  authorize('inmuebles', 'create'),
  inmueblesController.uploadFachada,
);

router.patch(
  '/:id',
  authorize('inmuebles', 'update'),
  validate({ params: inmuebleIdParamsSchema, body: updateInmuebleSchema }),
  inmueblesController.update,
);

// Toggle vitrina visibility (admin only) — HP-369
router.patch(
  '/:id/visibility',
  roleGuard(['administrador']),
  authorize('inmuebles', 'update'),
  validate({ params: inmuebleIdParamsSchema, body: visibilitySchema }),
  inmueblesController.toggleVisibility,
);

// RN-006: Solo administrador puede ejecutar la baja logica
router.delete(
  '/:id',
  roleGuard(['administrador']),
  validate({ params: inmuebleIdParamsSchema }),
  inmueblesController.remove,
);

// --- Rutas de fotos (HP-203) ---
router.get(
  '/:id/fotos',
  authorize('inmuebles', 'read'),
  validate({ params: inmuebleIdOnlyParamsSchema }),
  fotosController.list,
);

router.post(
  '/:id/fotos',
  authorize('inmuebles', 'update'),
  validate({ params: inmuebleIdOnlyParamsSchema, body: createFotoSchema }),
  fotosController.create,
);

router.patch(
  '/:id/fotos/reordenar',
  authorize('inmuebles', 'update'),
  validate({ params: inmuebleIdOnlyParamsSchema, body: reordenarFotosSchema }),
  fotosController.reordenar,
);

router.patch(
  '/:id/fotos/:fotoId',
  authorize('inmuebles', 'update'),
  validate({ params: fotoIdParamsSchema, body: updateFotoSchema }),
  fotosController.update,
);

router.patch(
  '/:id/fotos/:fotoId/fachada',
  authorize('inmuebles', 'update'),
  validate({ params: fotoIdParamsSchema }),
  fotosController.setFachada,
);

router.delete(
  '/:id/fotos/:fotoId',
  authorize('inmuebles', 'update'),
  validate({ params: fotoIdParamsSchema }),
  fotosController.remove,
);

export default router;
