import { Router } from 'express';
import { authMiddleware, roleGuard } from '@/middleware/auth';
import { publicFormLimiter } from '@/middleware/rateLimiter';
import { validate } from '@/middleware/validate';
import {
  tokenParamSchema,
  miembroIdParamSchema,
  invitarMiembroSchema,
  registrarMiembroSchema,
  setVenTodoSchema,
  cambiarRolMiembroSchema,
} from './inmobiliaria-miembros.schema';
import * as controller from './inmobiliaria-miembros.controller';

// ── Router autenticado: /api/v1/inmobiliaria/miembros ──────────
// Sólo rol inmobiliaria; el owner-check fino vive en el service (assertOwner).
export const miembrosRouter = Router();

miembrosRouter.use(authMiddleware, roleGuard(['inmobiliaria']));

miembrosRouter.get('/', controller.list);

// Config de la org (owner-only, validado en el service): ¿los miembros ven
// toda la cartera o solo lo suyo?
miembrosRouter.patch(
  '/config',
  validate({ body: setVenTodoSchema }),
  controller.setVenTodo,
);

miembrosRouter.post(
  '/invitar',
  validate({ body: invitarMiembroSchema }),
  controller.invitar,
);

// Salir de la organización (cualquier miembro activo, incl. solo_lectura).
// Ruta estática ANTES de las de :id. Allowlisted para viewers en authMiddleware.
miembrosRouter.post('/salir', controller.salir);

miembrosRouter.post(
  '/:id/reenviar',
  validate({ params: miembroIdParamSchema }),
  controller.reenviar,
);

// Cambiar rol de un miembro activo (owner-only, validado en el service):
// promover a co-titular, degradar a miembro, o pasar a sólo lectura.
miembrosRouter.patch(
  '/:id/rol',
  validate({ params: miembroIdParamSchema, body: cambiarRolMiembroSchema }),
  controller.cambiarRol,
);

miembrosRouter.delete(
  '/:id',
  validate({ params: miembroIdParamSchema }),
  controller.revocar,
);

// ── Router público: /api/v1/public/invitacion-miembro ──────────
export const publicInvitacionMiembroRouter = Router();

// GET info de la invitación (sin auth).
publicInvitacionMiembroRouter.get(
  '/:token',
  publicFormLimiter,
  validate({ params: tokenParamSchema }),
  controller.getPublic,
);

// Aceptar con cuenta existente: requiere auth + rol inmobiliaria + email match.
publicInvitacionMiembroRouter.post(
  '/:token/aceptar',
  authMiddleware,
  roleGuard(['inmobiliaria']),
  publicFormLimiter,
  validate({ params: tokenParamSchema }),
  controller.aceptar,
);

// Registrar cuenta nueva a partir de la invitación (sin auth — el email sale del token).
publicInvitacionMiembroRouter.post(
  '/:token/registrar',
  publicFormLimiter,
  validate({ params: tokenParamSchema, body: registrarMiembroSchema }),
  controller.registrar,
);
