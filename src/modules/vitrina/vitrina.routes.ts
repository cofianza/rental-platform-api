// ============================================================
// Vitrina Publica — Routes (HP-368)
// Solicitante registration (public) & interest creation (auth)
// ============================================================

import { Router } from 'express';
import { authMiddleware, roleGuard } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { publicFormLimiter } from '@/middleware/rateLimiter';
import { registerSolicitanteSchema, interestSchema } from './vitrina.schema';
import * as controller from './vitrina.controller';

const router = Router();

// Public: register solicitante (no auth required)
router.post(
  '/register',
  publicFormLimiter,
  validate({ body: registerSolicitanteSchema }),
  controller.registerSolicitante,
);

// Authenticated: create interest (expediente + estudio). Solo el arrendatario:
// sin el guard, una cuenta de otra inmobiliaria creaba un estudio en un inmueble
// ajeno con los datos de un cliente suyo (la web ya lo limitaba al solicitante).
router.post(
  '/interest',
  authMiddleware,
  roleGuard(['solicitante']),
  validate({ body: interestSchema }),
  controller.createInterest,
);

export { router as vitrinaRouter };
