import { Router } from 'express';
import { authMiddleware, authorize, roleGuard } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import {
  facturaIdParamsSchema,
  pagoIdParamsSchema,
  listFacturasQuerySchema,
  updateTarifasIvaSchema,
  facturarPagoSchema,
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

// GET /facturas/configuracion-iva — listar tasas configuradas
// (admin + operador pueden leer; solo admin escribe).
// IMPORTANTE: declarar antes de /:id para que Express no lo capture.
facturasRouter.get(
  '/configuracion-iva',
  roleGuard(['administrador', 'operador_analista']),
  controller.getTarifasIva,
);

// PUT /facturas/configuracion-iva — actualizar tasas (solo admin)
facturasRouter.put(
  '/configuracion-iva',
  roleGuard(['administrador']),
  validate({ body: updateTarifasIvaSchema }),
  controller.updateTarifasIva,
);

// GET /facturas/:id — detalle
facturasRouter.get(
  '/:id',
  authorize('facturas', 'read'),
  validate({ params: facturaIdParamsSchema }),
  controller.getById,
);

// GET /facturas/:id/factus/:tipo — descarga PDF/XML directo desde Factus
// (tipo: pdf | xml; ?inline=true para preview en el navegador)
facturasRouter.get(
  '/:id/factus/:tipo',
  authorize('facturas', 'read'),
  controller.downloadFactusDocumento,
);

// ============================================================
// Authenticated — /api/v1/pagos/:pagoId/facturar
// ============================================================

export const pagoFacturarRouter = Router({ mergeParams: true });
pagoFacturarRouter.use(authMiddleware);

// POST /pagos/:pagoId/facturar — disparar facturación manual desde un pago.
// Cofianza emite la factura, pero cualquier rol que gestione el expediente
// (incluido el propietario del inmueble) puede dispararla. El solicitante
// tambien puede facturar SU propio pago (controller valida pertenencia).
// Body opcional con datos fiscales override (numero_documento, direccion,
// telefono, municipio_codigo, etc.) — si vienen, se valida estricto.
pagoFacturarRouter.post(
  '/:pagoId/facturar',
  roleGuard(['administrador', 'operador_analista', 'inmobiliaria', 'propietario', 'solicitante']),
  validate({ params: pagoIdParamsSchema, body: facturarPagoSchema }),
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
