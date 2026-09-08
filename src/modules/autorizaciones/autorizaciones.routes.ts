import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { authMiddleware, authorize, roleGuard } from '@/middleware/auth';
import {
  publicFormLimiter,
  otpSendByTokenLimiter,
  otpVerifyByTokenLimiter,
} from '@/middleware/rateLimiter';
import {
  expedienteIdParamsSchema,
  tokenParamsSchema,
  enviarEnlaceAutorizacionSchema,
  firmarSchema,
  revocarSchema,
  verificarOtpSchema,
  perfilProspectoSchema,
  reportarIdentidadSchema,
  biometriaSchema,
} from './autorizaciones.schema';
import * as autorizacionesController from './autorizaciones.controller';

// ============================================================
// Router 1: Auth — /expedientes/:expedienteId/autorizacion-riesgo
// ============================================================

export const expedienteAutorizacionRouter = Router({ mergeParams: true });

expedienteAutorizacionRouter.use(authMiddleware);

// GET /expedientes/:expedienteId/autorizacion-riesgo
expedienteAutorizacionRouter.get(
  '/',
  authorize('expedientes', 'read'),
  validate({ params: expedienteIdParamsSchema }),
  autorizacionesController.getAutorizacionStatus,
);

// POST /expedientes/:expedienteId/autorizacion-riesgo/enviar-enlace
// roleGuard (no authorize('expedientes','update')): el propietario gestiona el
// estudio de su candidato y su UI ofrece "Enviar/Reenviar enlace", pero darle
// expedientes:update abriría una docena de rutas que no le corresponden.
// Body opcional { email?, telefono? }: corrige el contacto del solicitante si
// estaba mal escrito (se persiste server-side y el enlace va al corregido).
expedienteAutorizacionRouter.post(
  '/enviar-enlace',
  roleGuard(['administrador', 'operador_analista', 'inmobiliaria', 'propietario']),
  validate({ params: expedienteIdParamsSchema, body: enviarEnlaceAutorizacionSchema }),
  autorizacionesController.enviarEnlace,
);

// PATCH /expedientes/:expedienteId/autorizacion-riesgo/revocar
expedienteAutorizacionRouter.patch(
  '/revocar',
  authorize('expedientes', 'update'),
  validate({ params: expedienteIdParamsSchema, body: revocarSchema }),
  autorizacionesController.revocarAutorizacion,
);

// ============================================================
// Router 2: Public — /public/autorizar/:token
// ============================================================

export const publicAutorizacionRouter = Router();

// GET /public/autorizar/:token
publicAutorizacionRouter.get(
  '/:token',
  publicFormLimiter,
  validate({ params: tokenParamsSchema }),
  autorizacionesController.getAutorizacionPublic,
);

// GET /public/autorizar/:token/pago — estado del cobro tras firmar
publicAutorizacionRouter.get(
  '/:token/pago',
  publicFormLimiter,
  validate({ params: tokenParamsSchema }),
  autorizacionesController.getPagoProspecto,
);

// POST /public/autorizar/:token/firmar
publicAutorizacionRouter.post(
  '/:token/firmar',
  publicFormLimiter,
  validate({ params: tokenParamsSchema, body: firmarSchema }),
  autorizacionesController.firmar,
);

// POST /public/autorizar/:token/enviar-otp
// publicFormLimiter (por IP) + otpSendByTokenLimiter (por token) en cascada.
publicAutorizacionRouter.post(
  '/:token/enviar-otp',
  publicFormLimiter,
  otpSendByTokenLimiter,
  validate({ params: tokenParamsSchema }),
  autorizacionesController.enviarOtp,
);

// POST /public/autorizar/:token/verificar-otp
// Defensa anti fuerza bruta del OTP: límite por token (8/15min) además del de IP.
publicAutorizacionRouter.post(
  '/:token/verificar-otp',
  publicFormLimiter,
  otpVerifyByTokenLimiter,
  validate({ params: tokenParamsSchema, body: verificarOtpSchema }),
  autorizacionesController.verificarOtp,
);

// POST /public/autorizar/:token/perfil — PASO 5 (Flujo §8.1/§8.2/§8.3).
// Una sola llamada, al salir del paso "Sobre ti" y ANTES del paso de firma:
// el OTP se dispara al entrar a firma y caduca a los 5 minutos, asi que meter
// formularios despues de ese disparo llevaria al prospecto a firmar con
// OTP_EXPIRADO. Hereda publicFormLimiter (60/min por IP) como el resto.
publicAutorizacionRouter.post(
  '/:token/perfil',
  publicFormLimiter,
  validate({ params: tokenParamsSchema, body: perfilProspectoSchema }),
  autorizacionesController.guardarPerfil,
);

// POST /public/autorizar/:token/biometria — Politica Anexo A ("cedula validada
// via biometria AUCO") + §14 ("no aprobar automaticamente sin validacion de
// identidad"). Cierra el riesgo del Flujo §12: enlace reenviado a un tercero.
//
// otpSendByTokenLimiter, no solo el de IP: cada llamada es una consulta
// FACTURABLE a Auco y el enlace es publico. Reusar el limite del OTP por token
// (mismo orden de magnitud de reintentos legitimos) evita inventar un limiter
// mas y deja el gasto acotado por enlace, no por IP — que en movil es
// compartida por media ciudad.
publicAutorizacionRouter.post(
  '/:token/biometria',
  publicFormLimiter,
  otpSendByTokenLimiter,
  validate({ params: tokenParamsSchema, body: biometriaSchema }),
  autorizacionesController.verificarBiometria,
);

// POST /public/autorizar/:token/biometria/omitir — Ley 1581 art. 6-a: el
// titular NO esta obligado a autorizar datos sensibles. Sin body.
publicAutorizacionRouter.post(
  '/:token/biometria/omitir',
  publicFormLimiter,
  validate({ params: tokenParamsSchema }),
  autorizacionesController.omitirBiometria,
);

// POST /public/autorizar/:token/reportar-identidad — §8.1 + §12
// ("El prospecto reporta que no es el. El estudio se detiene, se marca para
// revision y se notifica al solicitante y a Cofianza").
publicAutorizacionRouter.post(
  '/:token/reportar-identidad',
  publicFormLimiter,
  validate({ params: tokenParamsSchema, body: reportarIdentidadSchema }),
  autorizacionesController.reportarIdentidad,
);
