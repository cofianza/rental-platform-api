import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { authMiddleware } from '@/middleware/auth';
import { authLimiter, passwordResetLimiter, enlaceMagicoPorCorreoLimiter, enlaceMagicoPorIpLimiter } from '@/middleware/rateLimiter';
import { loginSchema, refreshSchema, enlaceMagicoSchema, verificarEnlaceMagicoSchema, forgotPasswordSchema, resetPasswordSchema, resetTokenParamsSchema, updateMyProfileSchema } from './auth.schema';
import * as authController from './auth.controller';

const router = Router();

// Rutas publicas (login con rate limit agresivo)
router.post('/login', authLimiter, validate({ body: loginSchema }), authController.login);
router.post('/refresh', validate({ body: refreshSchema }), authController.refresh);

// Enlace mágico del arrendatario invitado (H44): pedir el enlace y canjearlo.
// El canje es POST (el token_hash nunca viaja en una URL de la API).
router.post(
  '/enlace-magico',
  validate({ body: enlaceMagicoSchema }),
  enlaceMagicoPorIpLimiter,
  enlaceMagicoPorCorreoLimiter,
  authController.solicitarEnlaceMagico,
);
router.post('/enlace-magico/verificar', authLimiter, validate({ body: verificarEnlaceMagicoSchema }), authController.verificarEnlaceMagico);

// Recuperacion de contrasena
router.post('/forgot-password', passwordResetLimiter, validate({ body: forgotPasswordSchema }), authController.forgotPassword);
router.get('/reset-password/:token', validate({ params: resetTokenParamsSchema }), authController.validateResetToken);
router.post('/reset-password', validate({ body: resetPasswordSchema }), authController.resetPassword);

// Rutas protegidas (requieren autenticacion)
router.post('/logout', authMiddleware, authController.logout);
router.get('/me', authMiddleware, authController.me);
router.get('/permissions', authMiddleware, authController.permissions);

// Mi cuenta — perfil extendido editable por el propio usuario
router.get('/me/perfil', authMiddleware, authController.getMyProfile);
router.patch(
  '/me/perfil',
  authMiddleware,
  validate({ body: updateMyProfileSchema }),
  authController.updateMyProfile,
);

export default router;
