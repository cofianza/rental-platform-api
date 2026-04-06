// ============================================================
// Vitrina Publica — Routes (HP-368)
// Solicitante registration (public) & interest creation (auth)
// ============================================================

import { Router } from 'express';
import { authMiddleware } from '@/middleware/auth';
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

// Authenticated: create interest (expediente + estudio)
router.post(
  '/interest',
  authMiddleware,
  validate({ body: interestSchema }),
  controller.createInterest,
);

export { router as vitrinaRouter };
