import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { authMiddleware, authorize } from '@/middleware/auth';
import { publicFormLimiter } from '@/middleware/rateLimiter';
import {
  expedienteIdParamsSchema,
  estudioIdParamsSchema,
  tokenParamsSchema,
  createEstudioSchema,
  listEstudiosQuerySchema,
  submitFormularioSchema,
  registrarResultadoSchema,
  certificadoPresignedUrlSchema,
} from './estudios.schema';
import * as estudiosController from './estudios.controller';

// ============================================================
// Router 1: Nested under /expedientes/:expedienteId/estudios
// ============================================================

export const expedienteEstudiosRouter = Router({ mergeParams: true });

expedienteEstudiosRouter.use(authMiddleware);

// GET /expedientes/:expedienteId/estudios
expedienteEstudiosRouter.get(
  '/',
  authorize('expedientes', 'read'),
  validate({ params: expedienteIdParamsSchema, query: listEstudiosQuerySchema }),
  estudiosController.listByExpediente,
);

// POST /expedientes/:expedienteId/estudios
expedienteEstudiosRouter.post(
  '/',
  authorize('expedientes', 'update'),
  validate({ params: expedienteIdParamsSchema, body: createEstudioSchema }),
  estudiosController.create,
);

// ============================================================
// Router 2: Standalone /estudios/:estudioId
// ============================================================

export const estudiosRouter = Router();

estudiosRouter.use(authMiddleware);

// GET /estudios/:estudioId
estudiosRouter.get(
  '/:estudioId',
  authorize('expedientes', 'read'),
  validate({ params: estudioIdParamsSchema }),
  estudiosController.getById,
);

// PATCH /estudios/:estudioId/cancelar
estudiosRouter.patch(
  '/:estudioId/cancelar',
  authorize('expedientes', 'update'),
  validate({ params: estudioIdParamsSchema }),
  estudiosController.cancel,
);

// POST /estudios/:estudioId/enviar-enlace
estudiosRouter.post(
  '/:estudioId/enviar-enlace',
  authorize('expedientes', 'update'),
  validate({ params: estudioIdParamsSchema }),
  estudiosController.sendLink,
);

// PATCH /estudios/:estudioId/resultado
estudiosRouter.patch(
  '/:estudioId/resultado',
  authorize('expedientes', 'update'),
  validate({ params: estudioIdParamsSchema, body: registrarResultadoSchema }),
  estudiosController.registrarResultado,
);

// POST /estudios/:estudioId/certificado/presigned-url
estudiosRouter.post(
  '/:estudioId/certificado/presigned-url',
  authorize('expedientes', 'update'),
  validate({ params: estudioIdParamsSchema, body: certificadoPresignedUrlSchema }),
  estudiosController.getCertificadoPresignedUrl,
);

// GET /estudios/:estudioId/certificado/url
estudiosRouter.get(
  '/:estudioId/certificado/url',
  authorize('expedientes', 'read'),
  validate({ params: estudioIdParamsSchema }),
  estudiosController.getCertificadoUrl,
);

// ============================================================
// Router 3: Public /public/estudios/:token/formulario
// ============================================================

export const publicEstudiosRouter = Router();

// GET /public/estudios/:token/formulario
publicEstudiosRouter.get(
  '/:token/formulario',
  publicFormLimiter,
  validate({ params: tokenParamsSchema }),
  estudiosController.getFormulario,
);

// POST /public/estudios/:token/formulario
publicEstudiosRouter.post(
  '/:token/formulario',
  publicFormLimiter,
  validate({ params: tokenParamsSchema, body: submitFormularioSchema }),
  estudiosController.submitFormulario,
);
