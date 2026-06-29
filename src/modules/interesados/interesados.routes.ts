// ============================================================
// Interesados de la vitrina — Routes (autenticadas)
// El POST público vive en public-properties.routes (/public/properties/:id/interes).
// ============================================================

import { Router } from 'express';
import { authMiddleware } from '@/middleware/auth';
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
router.patch(
  '/:id',
  validate({ params: interesadoIdParamsSchema, body: updateInteresadoSchema }),
  controller.updateEstado,
);

export { router as interesadosRouter };
