import { Router } from 'express';
import { authMiddleware, roleGuard } from '@/middleware/auth';
import { publicFormLimiter } from '@/middleware/rateLimiter';
import { validate } from '@/middleware/validate';
import { tokenParamSchema } from './invitacion.schema';
import * as controller from './invitacion.controller';

export const publicInvitacionRouter = Router();

// GET /api/v1/public/invitacion/:token — público, sin auth.
// Shape público: oculta expediente.id, solicitante_id, notas, teléfonos.
publicInvitacionRouter.get(
  '/:token',
  publicFormLimiter,
  validate({ params: tokenParamSchema }),
  controller.getInvitacion,
);

// POST /api/v1/public/invitacion/:token/canjear — requiere auth + rol solicitante.
// Valida email match contra req.user.email antes de vincular.
publicInvitacionRouter.post(
  '/:token/canjear',
  authMiddleware,
  roleGuard(['solicitante']),
  publicFormLimiter,
  validate({ params: tokenParamSchema }),
  controller.canjearInvitacion,
);
