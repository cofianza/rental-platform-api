import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { authMiddleware, authorize } from '@/middleware/auth';
import {
  listAdminTiposQuerySchema,
  tipoDocumentoIdSchema,
  createTipoDocumentoSchema,
  updateTipoDocumentoSchema,
  reordenarTiposSchema,
} from './admin-tipos-documento.schema';
import * as adminTiposController from './admin-tipos-documento.controller';

const router = Router();

// All routes require authentication + configuracion:update (admin only)
router.use(authMiddleware);
router.use(authorize('configuracion', 'update'));

// PATCH /reordenar must be BEFORE :id routes
router.patch('/reordenar', validate({ body: reordenarTiposSchema }), adminTiposController.reordenar);

router.get('/', validate({ query: listAdminTiposQuerySchema }), adminTiposController.list);
router.get('/:id', validate({ params: tipoDocumentoIdSchema }), adminTiposController.getById);
router.post('/', validate({ body: createTipoDocumentoSchema }), adminTiposController.create);
router.put('/:id', validate({ params: tipoDocumentoIdSchema, body: updateTipoDocumentoSchema }), adminTiposController.update);
router.patch('/:id/toggle-activo', validate({ params: tipoDocumentoIdSchema }), adminTiposController.toggleActivo);

export default router;
