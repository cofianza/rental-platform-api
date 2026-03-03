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

// Registro publico (sin autenticacion)
router.post(
  '/propietario',
  registrationLimiter,
  validate({ body: registerPropietarioSchema }),
  registrationController.registerPropietario,
);

router.post(
  '/inmobiliaria',
  registrationLimiter,
  validate({ body: registerInmobiliariaSchema }),
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
