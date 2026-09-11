import { Router } from 'express';
import { authMiddleware, authorize, roleGuard } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { expedienteIdParamsSchema, enviarLinkSchema, reenviarLinkSchema, pagoIdParamsSchema, reconciliarSchema, pagarGestorSchema } from './pago-estudio.schema';
import * as controller from './pago-estudio.controller';

// ============================================================
// Authenticated — /api/v1/expedientes/:expedienteId/pago-estudio
// ============================================================

const pagoEstudioRouter = Router({ mergeParams: true });
pagoEstudioRouter.use(authMiddleware);

// QUIEN DECIDE QUIEN PAGA nunca es el pagador. `authorize('pagos','create')`
// incluye al rol 'solicitante' (necesita crear su propio pago), y desde el
// §6.3 estas dos rutas dejaron de ser inertes para el prospecto: /asumir
// fabrica la fila 'completado' que satisface el gate de ejecucion y dispara
// la consulta FACTURABLE al buro, y /enviar-link emite el token de habeas
// data. `authorize` solo mira el permiso, no el rol, asi que el recorte va
// aqui (tambien en /pagar). Las rutas /cancelar-* no lo necesitan: piden
// 'pagos','update', que el solicitante no tiene.
const ROLES_GESTION_PAGO = ['administrador', 'operador_analista', 'inmobiliaria', 'propietario'];

pagoEstudioRouter.get(
  '/estado',
  authorize('pagos', 'read'),
  validate({ params: expedienteIdParamsSchema }),
  controller.getEstado,
);

// Opcion B (Adenda 2 §7): el gestor paga en el momento por la pasarela.
// Reemplaza a /asumir y /cancelar-y-asumir: la modalidad "a cuenta" no se
// aprobo. `reemplazar_pendiente` cancela antes el enlace vivo del prospecto.
pagoEstudioRouter.post(
  '/pagar',
  authorize('pagos', 'create'),
  roleGuard(ROLES_GESTION_PAGO),
  validate({ params: expedienteIdParamsSchema, body: pagarGestorSchema }),
  controller.pagar,
);

pagoEstudioRouter.post(
  '/enviar-link',
  authorize('pagos', 'create'),
  roleGuard(ROLES_GESTION_PAGO),
  validate({ params: expedienteIdParamsSchema, body: enviarLinkSchema }),
  controller.enviarLink,
);

// Body opcional { email_pagador?, nombre_pagador? } para corregir el destino
// si el email quedó mal escrito (no se puede re-crear el link: hay un pago
// pendiente activo que bloquea /enviar-link con 409).
pagoEstudioRouter.post(
  '/reenviar',
  authorize('pagos', 'update'),
  validate({ params: expedienteIdParamsSchema, body: reenviarLinkSchema }),
  controller.reenviar,
);

pagoEstudioRouter.post(
  '/cancelar-y-liberar-credito',
  authorize('pagos', 'update'),
  validate({ params: expedienteIdParamsSchema }),
  controller.cancelarYLiberarCredito,
);

// ============================================================
// Public — /api/v1/publico/pago-resultado/:pagoId
// ============================================================

const publicPagoResultadoRouter = Router();

publicPagoResultadoRouter.post(
  '/reconciliar',
  validate({ body: reconciliarSchema }),
  controller.reconciliarPublico,
);

publicPagoResultadoRouter.get(
  '/:pagoId',
  validate({ params: pagoIdParamsSchema }),
  controller.resultadoPublico,
);

export { pagoEstudioRouter, publicPagoResultadoRouter };
