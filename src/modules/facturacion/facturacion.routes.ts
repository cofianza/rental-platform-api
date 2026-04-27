import { Router } from 'express';
import { authMiddleware, authorize, roleGuard } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import {
  facturaIdParamsSchema,
  pagoIdParamsSchema,
  listFacturasQuerySchema,
} from './facturacion.schema';
import * as controller from './facturacion.controller';

// ============================================================
// Authenticated — /api/v1/facturas
// ============================================================

export const facturasRouter = Router();
facturasRouter.use(authMiddleware);

// GET /facturas — listar (filtra por rol; solicitante solo ve las suyas)
facturasRouter.get(
  '/',
  authorize('facturas', 'read'),
  validate({ query: listFacturasQuerySchema }),
  controller.list,
);

// GET /facturas/:id — detalle
facturasRouter.get(
  '/:id',
  authorize('facturas', 'read'),
  validate({ params: facturaIdParamsSchema }),
  controller.getById,
);

// ============================================================
// Authenticated — /api/v1/pagos/:pagoId/facturar
// ============================================================

export const pagoFacturarRouter = Router({ mergeParams: true });
pagoFacturarRouter.use(authMiddleware);

// POST /pagos/:pagoId/facturar — disparar facturación manual desde un pago
pagoFacturarRouter.post(
  '/:pagoId/facturar',
  roleGuard(['administrador', 'operador_analista', 'inmobiliaria']),
  validate({ params: pagoIdParamsSchema }),
  controller.facturarPago,
);

// ============================================================
// Authenticated — /api/v1/factus/municipalities (autocomplete)
// ============================================================

export const factusHelpersRouter = Router();
factusHelpersRouter.use(authMiddleware);

// GET /factus/municipalities?name=bog → buscar municipios (autocompletado UI)
factusHelpersRouter.get('/municipalities', controller.searchMunicipalities);

// ============================================================
// Public — /api/v1/public/factus/municipalities (para el wizard de registro
// que aún no tiene token). Solo lectura, rate-limited globalmente.
// ============================================================

export const factusPublicHelpersRouter = Router();
factusPublicHelpersRouter.get('/municipalities', controller.searchMunicipalities);
