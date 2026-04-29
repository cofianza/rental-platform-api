import { Router } from 'express';
import { authMiddleware } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import {
  listNotificacionesQuerySchema,
  notificacionIdParamsSchema,
} from './notificaciones.schema';
import * as controller from './notificaciones.controller';

const router = Router();
router.use(authMiddleware);

// GET /api/v1/notificaciones — listar las del usuario autenticado.
// ?solo_no_leidas=true para campanario; sin ese flag devuelve historial.
router.get(
  '/',
  validate({ query: listNotificacionesQuerySchema }),
  controller.list,
);

// GET /api/v1/notificaciones/no-leidas/count — badge del campanario.
// Util al primer render para evitar traer la lista completa solo por el numero.
router.get('/no-leidas/count', controller.getUnreadCount);

// POST /api/v1/notificaciones/marcar-todas-leidas — accion masiva.
// Va antes de /:id/leida para que Express no capture 'marcar-todas-leidas' como :id.
router.post('/marcar-todas-leidas', controller.markAllAsRead);

// PATCH /api/v1/notificaciones/:id/leida — marcar una sola como leida.
router.patch(
  '/:id/leida',
  validate({ params: notificacionIdParamsSchema }),
  controller.markAsRead,
);

export default router;
