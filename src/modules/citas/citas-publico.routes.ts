import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { publicFormLimiter } from '@/middleware/rateLimiter';
import {
  visitaTokenParamsSchema,
  visitaSlotsQuerySchema,
  reprogramarPublicaSchema,
  cancelarPublicaSchema,
} from './citas-publico.schema';
import * as ctrl from './citas-publico.controller';

// Rutas públicas (sin login) para gestionar una visita desde el WhatsApp.
// Montadas en /api/v1/public/visita. El token opaco de la cita es la
// autorización; el estado de la cita limita las acciones.
export const publicVisitaRouter = Router();

publicVisitaRouter.get(
  '/:token',
  publicFormLimiter,
  validate({ params: visitaTokenParamsSchema }),
  ctrl.getVisita,
);

publicVisitaRouter.get(
  '/:token/slots',
  publicFormLimiter,
  validate({ params: visitaTokenParamsSchema, query: visitaSlotsQuerySchema }),
  ctrl.getSlots,
);

publicVisitaRouter.post(
  '/:token/reprogramar',
  publicFormLimiter,
  validate({ params: visitaTokenParamsSchema, body: reprogramarPublicaSchema }),
  ctrl.reprogramar,
);

publicVisitaRouter.post(
  '/:token/cancelar',
  publicFormLimiter,
  validate({ params: visitaTokenParamsSchema, body: cancelarPublicaSchema }),
  ctrl.cancelar,
);

// Confirmar asistencia (botón "Confirmar" del WhatsApp). Sin body — el token basta.
publicVisitaRouter.post(
  '/:token/confirmar',
  publicFormLimiter,
  validate({ params: visitaTokenParamsSchema }),
  ctrl.confirmar,
);
