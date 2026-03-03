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
  rechazarDocumentoSchema,
  reemplazarDocumentoSchema,
  confirmarReemplazoSchema,
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

// PATCH /:id/aprobar - Aprobar documento
router.patch(
  '/:id/aprobar',
  authorize('documentos', 'validar'),
  validate({ params: documentoIdParamsSchema }),
  documentosController.aprobar,
);

// PATCH /:id/rechazar - Rechazar documento con motivo
router.patch(
  '/:id/rechazar',
  authorize('documentos', 'validar'),
  validate({ params: documentoIdParamsSchema, body: rechazarDocumentoSchema }),
  documentosController.rechazar,
);

// GET /:id/historial-revision - Historial de revisiones de un documento
router.get(
  '/:id/historial-revision',
  authorize('documentos', 'read'),
  validate({ params: documentoIdParamsSchema }),
  documentosController.historialRevision,
);

// GET /:id/url-visualizacion - URL segura de lectura (15 min)
router.get(
  '/:id/url-visualizacion',
  authorize('documentos', 'read'),
  validate({ params: documentoIdParamsSchema }),
  documentosController.urlVisualizacion,
);

// GET /:id/url-descarga - URL segura de descarga con nombre original
router.get(
  '/:id/url-descarga',
  authorize('documentos', 'read'),
  validate({ params: documentoIdParamsSchema }),
  documentosController.urlDescarga,
);

// POST /:id/reemplazar - Iniciar reemplazo de documento rechazado
router.post(
  '/:id/reemplazar',
  authorize('documentos', 'create'),
  validate({ params: documentoIdParamsSchema, body: reemplazarDocumentoSchema }),
  documentosController.reemplazar,
);

// POST /:id/confirmar-reemplazo - Confirmar subida del documento de reemplazo
router.post(
  '/:id/confirmar-reemplazo',
  authorize('documentos', 'create'),
  validate({ params: documentoIdParamsSchema, body: confirmarReemplazoSchema }),
  documentosController.confirmarReemplazo,
);

// GET /:id/versiones - Historial de versiones de un documento
router.get(
  '/:id/versiones',
  authorize('documentos', 'read'),
  validate({ params: documentoIdParamsSchema }),
  documentosController.versiones,
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
