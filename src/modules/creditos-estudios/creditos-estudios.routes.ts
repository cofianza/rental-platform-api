import { Router } from 'express';
import { authMiddleware, roleGuard } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import {
  comprarPaqueteSchema,
  createPaqueteSchema,
  updatePaqueteSchema,
  paqueteIdParamsSchema,
  listMovimientosQuerySchema,
  liberarEstudioCreditoSchema,
  compraIdParamsSchema,
  facturarCompraSchema,
} from './creditos-estudios.schema';
import * as controller from './creditos-estudios.controller';

// ============================================================
// Inmobiliaria-facing — /api/v1/creditos-estudios
// ============================================================

const creditosEstudiosRouter = Router();
creditosEstudiosRouter.use(authMiddleware);

// Paquetes activos (para mostrar al comprar)
creditosEstudiosRouter.get(
  '/paquetes',
  roleGuard(['inmobiliaria', 'administrador']),
  controller.listPaquetes,
);

// Saldo del perfil autenticado
creditosEstudiosRouter.get(
  '/me/saldo',
  roleGuard(['inmobiliaria', 'administrador']),
  controller.getMiSaldo,
);

// Movimientos / historial
creditosEstudiosRouter.get(
  '/me/movimientos',
  roleGuard(['inmobiliaria', 'administrador']),
  validate({ query: listMovimientosQuerySchema }),
  controller.getMisMovimientos,
);

// Compras
creditosEstudiosRouter.get(
  '/me/compras',
  roleGuard(['inmobiliaria', 'administrador']),
  controller.getMisCompras,
);

// Comprar paquete (crea Stripe Checkout)
creditosEstudiosRouter.post(
  '/me/comprar',
  roleGuard(['inmobiliaria']),
  validate({ body: comprarPaqueteSchema }),
  controller.comprarPaquete,
);

// Facturar compra de paquete — datos fiscales opcionales en el body
creditosEstudiosRouter.post(
  '/me/compras/:id/facturar',
  roleGuard(['inmobiliaria']),
  validate({ params: compraIdParamsSchema, body: facturarCompraSchema }),
  controller.facturarCompra,
);

// ============================================================
// Liberar estudio en expediente — /api/v1/expedientes/:expedienteId/liberar-estudio-credito
// ============================================================

const expedienteLiberarRouter = Router({ mergeParams: true });
expedienteLiberarRouter.use(authMiddleware);

expedienteLiberarRouter.post(
  '/',
  roleGuard(['inmobiliaria']),
  validate({ body: liberarEstudioCreditoSchema }),
  controller.liberarEstudio,
);

// ============================================================
// Super admin — /api/v1/admin/paquetes-creditos-estudios
// ============================================================

const adminPaquetesRouter = Router();
adminPaquetesRouter.use(authMiddleware);
adminPaquetesRouter.use(roleGuard(['administrador']));

adminPaquetesRouter.get('/', controller.adminListPaquetes);

adminPaquetesRouter.post(
  '/',
  validate({ body: createPaqueteSchema }),
  controller.adminCreatePaquete,
);

adminPaquetesRouter.put(
  '/:id',
  validate({ params: paqueteIdParamsSchema, body: updatePaqueteSchema }),
  controller.adminUpdatePaquete,
);

adminPaquetesRouter.delete(
  '/:id',
  validate({ params: paqueteIdParamsSchema }),
  controller.adminDeletePaquete,
);

export { creditosEstudiosRouter, expedienteLiberarRouter, adminPaquetesRouter };
