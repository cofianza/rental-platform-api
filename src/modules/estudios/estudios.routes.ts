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
  listAllEstudiosQuerySchema,
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

// GET /estudios (global listing)
estudiosRouter.get(
  '/',
  authorize('estudios', 'read'),
  validate({ query: listAllEstudiosQuerySchema }),
  estudiosController.listAll,
);

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

// POST /estudios/:estudioId/ejecutar (execute via provider)
estudiosRouter.post(
  '/:estudioId/ejecutar',
  authorize('estudios', 'update'),
  validate({ params: estudioIdParamsSchema }),
  estudiosController.ejecutarEstudio,
);

// GET /estudios/:estudioId/estado-proveedor (check provider status)
estudiosRouter.get(
  '/:estudioId/estado-proveedor',
  authorize('estudios', 'read'),
  validate({ params: estudioIdParamsSchema }),
  estudiosController.getEstadoProveedor,
);

// ============================================================
// Router 4: /proveedores-riesgo (admin health check)
// ============================================================

export const proveedoresRiesgoRouter = Router();

proveedoresRiesgoRouter.use(authMiddleware);

// GET /proveedores-riesgo/salud
proveedoresRiesgoRouter.get(
  '/salud',
  authorize('configuracion', 'read'),
  estudiosController.getProviderHealth,
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
