import { Router } from 'express';
import { authMiddleware, authorize, roleGuard } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { uploadDoc } from '@/middleware/upload';
import { subirArchivoParamsSchema, subirArchivoBodySchema, archivoIdParamsSchema } from './contrato-archivos.schema';
import * as archivosController from './contrato-archivos.controller';

const router = Router();

router.use(authMiddleware);

// POST /api/v1/contratos/:id/archivos — Subir archivo asociado
router.post(
  '/:id/archivos',
  roleGuard(['administrador', 'operador_analista']),
  uploadDoc,
  validate({ params: subirArchivoParamsSchema, body: subirArchivoBodySchema }),
  archivosController.subir,
);

// GET /api/v1/contratos/:id/archivos — Listar archivos del contrato
router.get(
  '/:id/archivos',
  authorize('contratos', 'read'),
  validate({ params: subirArchivoParamsSchema }),
  archivosController.listar,
);

// GET /api/v1/contratos/:id/archivos/:archivoId/descargar — Descargar archivo
router.get(
  '/:id/archivos/:archivoId/descargar',
  authorize('contratos', 'read'),
  validate({ params: archivoIdParamsSchema }),
  archivosController.descargar,
);

// DELETE /api/v1/contratos/:id/archivos/:archivoId — Eliminar archivo (solo admin)
router.delete(
  '/:id/archivos/:archivoId',
  roleGuard(['administrador']),
  validate({ params: archivoIdParamsSchema }),
  archivosController.eliminar,
);

export default router;
