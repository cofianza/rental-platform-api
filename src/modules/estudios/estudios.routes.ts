import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { authMiddleware, authorize, roleGuard } from '@/middleware/auth';
import { publicFormLimiter } from '@/middleware/rateLimiter';
import {
  expedienteIdParamsSchema,
  estudioIdParamsSchema,
  inmuebleIdParamsSchema,
  tokenParamsSchema,
  createEstudioSchema,
  createEstudioFromInmuebleSchema,
  listEstudiosQuerySchema,
  listAllEstudiosQuerySchema,
  submitFormularioSchema,
  registrarResultadoSchema,
  ejecutarEstudioBodySchema,
  enviarEnlaceBodySchema,
  certificadoPresignedUrlSchema,
  soportePresignedUrlSchema,
  confirmarSoporteSchema,
  reEvaluarSchema,
  reasignarEstudioSchema,
  codigoParamsSchema,
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

// GET /estudios/stats — KPI cards del listado global (counts por estado y
// resultado, total del mes, etc). ANTES de /:estudioId para que Express
// no lo matchee como param.
estudiosRouter.get(
  '/stats',
  authorize('estudios', 'read'),
  estudiosController.stats,
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

// POST /estudios/:estudioId/enviar-enlace — body opcional { email } para
// corregir el destino si el email del solicitante estaba mal escrito.
estudiosRouter.post(
  '/:estudioId/enviar-enlace',
  authorize('expedientes', 'update'),
  validate({ params: estudioIdParamsSchema, body: enviarEnlaceBodySchema }),
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

// POST /estudios/:estudioId/ejecutar (execute via provider).
// El solicitante puede dispararlo sobre SUS estudios; la inmobiliaria/
// propietario sobre estudios de un inmueble que administran (ambos con
// ownership check en el service) — la inmobiliaria paga el estudio y debe
// poder reintentarlo si la consulta a TransUnion falla. Admin/operador,
// cualquiera.
estudiosRouter.post(
  '/:estudioId/ejecutar',
  roleGuard(['administrador', 'operador_analista', 'solicitante', 'inmobiliaria', 'propietario']),
  validate({ params: estudioIdParamsSchema, body: ejecutarEstudioBodySchema }),
  estudiosController.ejecutarEstudio,
);

// GET /estudios/:estudioId/estado-proveedor (check provider status)
estudiosRouter.get(
  '/:estudioId/estado-proveedor',
  authorize('estudios', 'read'),
  validate({ params: estudioIdParamsSchema }),
  estudiosController.getEstadoProveedor,
);

// POST /estudios/:estudioId/certificado/generar
estudiosRouter.post(
  '/:estudioId/certificado/generar',
  authorize('expedientes', 'update'),
  validate({ params: estudioIdParamsSchema }),
  estudiosController.generarCertificado,
);

// GET /estudios/:estudioId/certificado/descargar
estudiosRouter.get(
  '/:estudioId/certificado/descargar',
  authorize('expedientes', 'read'),
  validate({ params: estudioIdParamsSchema }),
  estudiosController.descargarCertificado,
);

// POST /estudios/:estudioId/documentos-soporte/presigned-url
estudiosRouter.post(
  '/:estudioId/documentos-soporte/presigned-url',
  authorize('expedientes', 'update'),
  validate({ params: estudioIdParamsSchema, body: soportePresignedUrlSchema }),
  estudiosController.getSoportePresignedUrl,
);

// POST /estudios/:estudioId/documentos-soporte/confirmar
estudiosRouter.post(
  '/:estudioId/documentos-soporte/confirmar',
  authorize('expedientes', 'update'),
  validate({ params: estudioIdParamsSchema, body: confirmarSoporteSchema }),
  estudiosController.confirmarSoporte,
);

// POST /estudios/:estudioId/re-evaluar
estudiosRouter.post(
  '/:estudioId/re-evaluar',
  authorize('expedientes', 'update'),
  validate({ params: estudioIdParamsSchema, body: reEvaluarSchema }),
  estudiosController.reEvaluar,
);

// POST /estudios/:estudioId/reasignar — portabilidad del §4.3.
//
// roleGuard y no `authorize('expedientes','update')`, por el mismo motivo que
// /ejecutar: el PROPIETARIO tiene `expedientes: ['read']` y con `authorize`
// recibia un 403 seco ("Sin permisos para update en expedientes") despues de
// recorrer el modal y elegir la propiedad. Y el propietario es un destinatario
// natural del §4.3 — su candidato perdio el inmueble (§4.2) y quiere llevarle
// el estudio a otra propiedad SUYA, que es exactamente el beneficio comercial
// que el documento promete. Un callejon sin salida en una promesa comercial es
// peor que un permiso de mas.
//
// La lista cubre lo mismo que cubria `authorize` (quedan fuera
// gerencia_consulta y solicitante: la reasignacion la dispara el gestor, que es
// quien conoce el inventario) y no debilita nada: el bloqueo de escritura de
// los miembros 'solo_lectura' vive en authMiddleware, y el scoping fino —ser
// dueño del expediente Y del inmueble destino, y que ambos sean de la misma
// cartera— lo hace el servicio con assertExpedienteAccess +
// assertInmuebleAccess + el guard de cartera.
estudiosRouter.post(
  '/:estudioId/reasignar',
  roleGuard(['administrador', 'operador_analista', 'inmobiliaria', 'propietario']),
  validate({ params: estudioIdParamsSchema, body: reasignarEstudioSchema }),
  estudiosController.reasignar,
);

// GET /estudios/:estudioId/historial
estudiosRouter.get(
  '/:estudioId/historial',
  authorize('expedientes', 'read'),
  validate({ params: estudioIdParamsSchema }),
  estudiosController.getHistorial,
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
// Router 5: Nested under /inmuebles/:inmuebleId/estudios
// ============================================================

export const inmuebleEstudiosRouter = Router({ mergeParams: true });

inmuebleEstudiosRouter.use(authMiddleware);

// POST /inmuebles/:inmuebleId/estudios — Create estudio from inmueble (auto-creates expediente)
inmuebleEstudiosRouter.post(
  '/',
  authorize('expedientes', 'update'),
  validate({ params: inmuebleIdParamsSchema, body: createEstudioFromInmuebleSchema }),
  estudiosController.createFromInmueble,
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

// ============================================================
// Router 5: Public /public/verificar/:codigo
// ============================================================

export const publicVerificarRouter = Router();

// GET /public/verificar/:codigo
publicVerificarRouter.get(
  '/:codigo',
  publicFormLimiter,
  validate({ params: codigoParamsSchema }),
  estudiosController.verificarCertificadoPublic,
);
