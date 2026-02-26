/**
 * Rutas de documentos por expediente - /api/v1/expedientes/:expedienteId/documentos
 * Listado paginado con filtros
 */

import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { authMiddleware, authorize } from '@/middleware/auth';
import {
  expedienteIdParamsSchema,
  listDocumentosQuerySchema,
} from './documentos.schema';
import * as documentosController from './documentos.controller';

const router = Router();

router.use(authMiddleware);

// GET /:expedienteId/documentos - Listar documentos de un expediente
router.get(
  '/:expedienteId/documentos',
  authorize('documentos', 'read'),
  validate({ params: expedienteIdParamsSchema, query: listDocumentosQuerySchema }),
  documentosController.listByExpediente,
);

export default router;
