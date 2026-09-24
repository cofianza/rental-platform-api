import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { authMiddleware, authorize, roleGuard } from '@/middleware/auth';
import {
  listAdminTiposQuerySchema,
  tipoDocumentoIdSchema,
  createTipoDocumentoSchema,
  updateTipoDocumentoSchema,
  reordenarTiposSchema,
  checkCodigoQuerySchema,
} from './admin-tipos-documento.schema';
import * as adminTiposController from './admin-tipos-documento.controller';

const router = Router();

// Solo el administrador: el catálogo es global. configuracion:update solo no
// basta, porque también lo tienen propietario e inmobiliaria (para sus datos).
router.use(authMiddleware);
router.use(roleGuard(['administrador']));
router.use(authorize('configuracion', 'update'));

// PATCH /reordenar must be BEFORE :id routes
router.patch('/reordenar', validate({ body: reordenarTiposSchema }), adminTiposController.reordenar);

router.get('/check-codigo', validate({ query: checkCodigoQuerySchema }), adminTiposController.checkCodigo);
router.get('/', validate({ query: listAdminTiposQuerySchema }), adminTiposController.list);
router.get('/:id', validate({ params: tipoDocumentoIdSchema }), adminTiposController.getById);
router.post('/', validate({ body: createTipoDocumentoSchema }), adminTiposController.create);
router.put('/:id', validate({ params: tipoDocumentoIdSchema, body: updateTipoDocumentoSchema }), adminTiposController.update);
router.patch('/:id/toggle-activo', validate({ params: tipoDocumentoIdSchema }), adminTiposController.toggleActivo);

export default router;
