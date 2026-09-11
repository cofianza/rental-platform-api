import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { authMiddleware, authorize, roleGuard } from '@/middleware/auth';
import { publicFormLimiter } from '@/middleware/rateLimiter';
import {
  expedienteIdParamsSchema,
  estudioIdParamsSchema,
  tarifaOverrideSchema,
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
  estudioVigenteQuerySchema,
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

// GET /estudios/vigente?tipo_documento=cc&numero_documento=123 — §5.2: avisar
// en el paso 2 del asistente si esa persona ya tiene un estudio vigente, para
// ofrecer reutilizarlo "en lugar de crear uno nuevo y cobrarlo". Va ANTES del
// listado global para que '/vigente' no lo capture ninguna ruta con :estudioId.
// GET /estudios/tope-canon — Flujo §4.4: el asistente lo consulta en el paso 1
// para no dejar elegir un inmueble que el sistema no puede afianzar.
estudiosRouter.get('/tope-canon', estudiosController.getTopeCanon);

estudiosRouter.get(
  '/vigente',
  authorize('expedientes', 'read'),
  validate({ query: estudioVigenteQuerySchema }),
  estudiosController.estudioVigentePorDocumento,
);

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
// Adenda 2 §5: registrar el resultado a mano es una decisión de riesgo y es
// SOLO de Cofianza. Con `authorize('expedientes','update')` la inmobiliaria
// podía marcar 'aprobado' un estudio suyo en 'solicitado' sin consultar
// ningún buró. Mismo guard para el certificado y la re-evaluación de abajo.
estudiosRouter.patch(
  '/:estudioId/resultado',
  roleGuard(['administrador', 'operador_analista']),
  validate({ params: estudioIdParamsSchema, body: registrarResultadoSchema }),
  estudiosController.registrarResultado,
);

// Adenda §5 (nota): tarifa del estudio (tabla estandar + condiciones
// especiales). Ver: cualquiera que vea el expediente. Poner/quitar: solo
// Gerencia General (administrador), con registro de quien y cuando.
estudiosRouter.get(
  '/:estudioId/tarifa',
  authorize('expedientes', 'read'),
  validate({ params: estudioIdParamsSchema }),
  estudiosController.getTarifa,
);
estudiosRouter.patch(
  '/:estudioId/tarifa',
  roleGuard(['administrador']),
  validate({ params: estudioIdParamsSchema, body: tarifaOverrideSchema }),
  estudiosController.setTarifaOverride,
);
estudiosRouter.delete(
  '/:estudioId/tarifa',
  roleGuard(['administrador']),
  validate({ params: estudioIdParamsSchema }),
  estudiosController.quitarTarifaOverride,
);

// POST /estudios/:estudioId/certificado/presigned-url — solo lo usa el
// registro manual del resultado (arriba), así que lleva su mismo guard.
estudiosRouter.post(
  '/:estudioId/certificado/presigned-url',
  roleGuard(['administrador', 'operador_analista']),
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

// POST /estudios/:estudioId/re-evaluar — crea el estudio hijo que luego se
// resuelve con /resultado; es parte de la revisión manual (Adenda 2 §5), así
// que es solo de Cofianza. La web ya lo mostraba solo a admin/operador.
estudiosRouter.post(
  '/:estudioId/re-evaluar',
  roleGuard(['administrador', 'operador_analista']),
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
