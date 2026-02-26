/**
 * Rutas de documentos - /api/v1/documentos
 * Presigned URL, confirmar subida, detalle, eliminar
 */

import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { authMiddleware, authorize } from '@/middleware/auth';
import {
  presignedUrlSchema,
  confirmarSubidaSchema,
  documentoIdParamsSchema,
} from './documentos.schema';
import * as documentosController from './documentos.controller';

const router = Router();

router.use(authMiddleware);

// POST /presigned-url - Generar URL segura para subida directa
router.post(
  '/presigned-url',
  authorize('documentos', 'create'),
  validate({ body: presignedUrlSchema }),
  documentosController.presignedUrl,
);

// POST /confirmar-subida - Confirmar subida exitosa y registrar en BD
router.post(
  '/confirmar-subida',
  authorize('documentos', 'create'),
  validate({ body: confirmarSubidaSchema }),
  documentosController.confirmarSubida,
);

// GET /:id - Detalle de un documento
router.get(
  '/:id',
  authorize('documentos', 'read'),
  validate({ params: documentoIdParamsSchema }),
  documentosController.getById,
);

// DELETE /:id - Eliminar documento (solo si estado=pendiente)
router.delete(
  '/:id',
  authorize('documentos', 'delete'),
  validate({ params: documentoIdParamsSchema }),
  documentosController.remove,
);

export default router;
