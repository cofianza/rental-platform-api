import { Router } from 'express';
import { authMiddleware, authorize, roleGuard } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import {
  upsertDisponibilidadSchema,
  propietarioIdParamsSchema,
  slotsQuerySchema,
} from './disponibilidad.schema';
import * as controller from './disponibilidad.controller';

const router = Router();
router.use(authMiddleware);

// GET /api/v1/disponibilidad/slots — solicitante consulta slots por inmueble.
// Va antes de /:propietarioId para evitar colisión de patrones.
router.get(
  '/slots',
  authorize('disponibilidad', 'read'),
  validate({ query: slotsQuerySchema }),
  controller.getSlots,
);

// GET /api/v1/disponibilidad/mi-disponibilidad — propietario/inmobiliaria.
router.get(
  '/mi-disponibilidad',
  authorize('disponibilidad', 'read_own'),
  controller.getMiDisponibilidad,
);

// PUT /api/v1/disponibilidad/mi-disponibilidad — idempotente.
router.put(
  '/mi-disponibilidad',
  authorize('disponibilidad', 'update'),
  validate({ body: upsertDisponibilidadSchema }),
  controller.putMiDisponibilidad,
);

// GET /api/v1/disponibilidad/:propietarioId — admin/operador/gerencia.
// Guard fino por rol porque `disponibilidad:read` también lo tiene el
// solicitante (que lo usa con /slots), y no queremos exponerle esta ruta.
router.get(
  '/:propietarioId',
  roleGuard(['administrador', 'operador_analista', 'gerencia_consulta']),
  validate({ params: propietarioIdParamsSchema }),
  controller.getDisponibilidadAjena,
);

export default router;
