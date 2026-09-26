// ============================================================
// Interesados de la vitrina — Routes (autenticadas)
// El POST público vive en public-properties.routes (/public/properties/:id/interes).
// ============================================================

import { Router } from 'express';
import { authMiddleware, roleGuard } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import {
  listInteresadosQuerySchema,
  interesadoIdParamsSchema,
  updateInteresadoSchema,
} from './interesados.schema';
import * as controller from './interesados.controller';

const router = Router();

router.use(authMiddleware);

// GET /api/v1/interesados/count — conteo de 'nuevo' (badge). Antes de '/'.
router.get('/count', controller.countNuevos);

// GET /api/v1/interesados — lista scopeada a los inmuebles del usuario
router.get('/', validate({ query: listInteresadosQuerySchema }), controller.list);

// PATCH /api/v1/interesados/:id — cambiar estado (nuevo/contactado/descartado)
// Gerencia (solo lectura) y el solicitante no gestionan leads; el service
// scopea por cartera a propietario e inmobiliaria.
router.patch(
  '/:id',
  roleGuard(['administrador', 'operador_analista', 'propietario', 'inmobiliaria']),
  validate({ params: interesadoIdParamsSchema, body: updateInteresadoSchema }),
  controller.updateEstado,
);

export { router as interesadosRouter };
