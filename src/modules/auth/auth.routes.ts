import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { authMiddleware } from '@/middleware/auth';
import { authLimiter, passwordResetLimiter } from '@/middleware/rateLimiter';
import { loginSchema, refreshSchema, forgotPasswordSchema, resetPasswordSchema, resetTokenParamsSchema } from './auth.schema';
import * as authController from './auth.controller';

const router = Router();

// Rutas publicas (login con rate limit agresivo)
router.post('/login', authLimiter, validate({ body: loginSchema }), authController.login);
router.post('/login/google', authLimiter, authController.googleOAuth);
router.post('/refresh', validate({ body: refreshSchema }), authController.refresh);

// Recuperacion de contrasena
router.post('/forgot-password', passwordResetLimiter, validate({ body: forgotPasswordSchema }), authController.forgotPassword);
router.get('/reset-password/:token', validate({ params: resetTokenParamsSchema }), authController.validateResetToken);
router.post('/reset-password', validate({ body: resetPasswordSchema }), authController.resetPassword);

// Rutas protegidas (requieren autenticacion)
router.post('/logout', authMiddleware, authController.logout);
router.get('/me', authMiddleware, authController.me);
router.get('/permissions', authMiddleware, authController.permissions);

export default router;
