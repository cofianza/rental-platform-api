import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { authMiddleware } from '@/middleware/auth';
import { loginSchema, refreshSchema } from './auth.schema';
import * as authController from './auth.controller';

const router = Router();

// Rutas publicas (no requieren autenticacion)
router.post('/login', validate({ body: loginSchema }), authController.login);
router.post('/login/google', authController.googleOAuth);
router.post('/refresh', validate({ body: refreshSchema }), authController.refresh);

// Rutas protegidas (requieren autenticacion)
router.post('/logout', authMiddleware, authController.logout);
router.get('/me', authMiddleware, authController.me);

export default router;
