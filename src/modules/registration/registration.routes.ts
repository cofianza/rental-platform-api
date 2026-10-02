import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { registrationLimiter, resendVerificationLimiter } from '@/middleware/rateLimiter';
import {
  registerPropietarioSchema,
  registerInmobiliariaSchema,
  verifyEmailParamsSchema,
  resendVerificationSchema,
} from './registration.schema';
import * as registrationController from './registration.controller';

const router = Router();

// Registro publico (sin autenticacion). Primero la validación y después el tope
// (como en «Me interesa»): un formulario mal llenado no gasta uno de los 5
// registros por hora; los válidos cuentan todos, también los que terminan en 409.
router.post(
  '/propietario',
  validate({ body: registerPropietarioSchema }),
  registrationLimiter,
  registrationController.registerPropietario,
);

router.post(
  '/inmobiliaria',
  validate({ body: registerInmobiliariaSchema }),
  registrationLimiter,
  registrationController.registerInmobiliaria,
);

// Verificacion de email
router.get(
  '/verify-email/:token',
  validate({ params: verifyEmailParamsSchema }),
  registrationController.verifyEmail,
);

// Reenvio de email de verificacion
router.post(
  '/resend-verification',
  resendVerificationLimiter,
  validate({ body: resendVerificationSchema }),
  registrationController.resendVerification,
);

export default router;
