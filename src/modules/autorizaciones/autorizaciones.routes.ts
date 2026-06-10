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
  firmarSchema,
  revocarSchema,
  verificarOtpSchema,
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
expedienteAutorizacionRouter.post(
  '/enviar-enlace',
  roleGuard(['administrador', 'operador_analista', 'inmobiliaria', 'propietario']),
  validate({ params: expedienteIdParamsSchema }),
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
