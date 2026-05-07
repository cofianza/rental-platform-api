import { Router } from 'express';
import { authMiddleware, roleGuard } from '@/middleware/auth';
import { publicFormLimiter } from '@/middleware/rateLimiter';
import { validate } from '@/middleware/validate';
import { expedienteIdParamsSchema } from '../expedientes/expedientes.schema';
import {
  invitarCoarrendatarioSchema,
  tokenParamSchema,
  aceptarCoarrendatarioSchema,
} from './coarrendatarios.schema';
import * as controller from './coarrendatarios.controller';

// ── Privado: el solicitante / propietario invita ──────────────────
// Montado bajo /api/v1/expedientes
export const expedienteCoarrendatariosRouter = Router();

// POST /api/v1/expedientes/:id/coarrendatario — crear invitación.
expedienteCoarrendatariosRouter.post(
  '/:id/coarrendatario',
  authMiddleware,
  roleGuard(['solicitante', 'propietario', 'inmobiliaria', 'administrador', 'operador_analista']),
  validate({ params: expedienteIdParamsSchema, body: invitarCoarrendatarioSchema }),
  controller.invitar,
);

// GET /api/v1/expedientes/:id/coarrendatario — ver el coarrendatario actual.
expedienteCoarrendatariosRouter.get(
  '/:id/coarrendatario',
  authMiddleware,
  roleGuard(['solicitante', 'propietario', 'inmobiliaria', 'administrador', 'operador_analista']),
  validate({ params: expedienteIdParamsSchema }),
  controller.getDelExpediente,
);

// ── Público: el invitado abre /coarrendatario/[token] ─────────────
// Montado bajo /api/v1/public/coarrendatario
export const publicCoarrendatarioRouter = Router();

// GET /api/v1/public/coarrendatario/:token — info para mostrar al invitado.
publicCoarrendatarioRouter.get(
  '/:token',
  publicFormLimiter,
  validate({ params: tokenParamSchema }),
  controller.getPublic,
);

// POST /api/v1/public/coarrendatario/:token/aceptar — aceptar T&C + dispara estudio.
publicCoarrendatarioRouter.post(
  '/:token/aceptar',
  publicFormLimiter,
  validate({ params: tokenParamSchema, body: aceptarCoarrendatarioSchema }),
  controller.aceptar,
);

// POST /api/v1/public/coarrendatario/:token/rechazar — declinar la invitación.
publicCoarrendatarioRouter.post(
  '/:token/rechazar',
  publicFormLimiter,
  validate({ params: tokenParamSchema }),
  controller.rechazar,
);
