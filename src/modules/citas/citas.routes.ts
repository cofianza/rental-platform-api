import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { authMiddleware, authorize } from '@/middleware/auth';
import {
  createCitaSchema,
  confirmarCitaSchema,
  realizarCitaSchema,
  cancelarCitaSchema,
  citaIdParamsSchema,
  listCitasQuerySchema,
} from './citas.schema';
import * as citasController from './citas.controller';

const router = Router();

// Todas las rutas requieren autenticacion JWT
router.use(authMiddleware);

// GET / — Listar citas con filtros
router.get(
  '/',
  authorize('citas', 'read'),
  validate({ query: listCitasQuerySchema }),
  citasController.listByExpediente,
);

// GET /:id — Detalle de una cita
router.get(
  '/:id',
  authorize('citas', 'read'),
  validate({ params: citaIdParamsSchema }),
  citasController.getById,
);

// POST / — Crear cita
router.post(
  '/',
  authorize('citas', 'create'),
  validate({ body: createCitaSchema }),
  citasController.create,
);

// POST /:id/confirmar — Confirmar cita
router.post(
  '/:id/confirmar',
  authorize('citas', 'update'),
  validate({ params: citaIdParamsSchema, body: confirmarCitaSchema }),
  citasController.confirmar,
);

// POST /:id/realizar — Marcar como realizada
router.post(
  '/:id/realizar',
  authorize('citas', 'update'),
  validate({ params: citaIdParamsSchema, body: realizarCitaSchema }),
  citasController.realizar,
);

// POST /:id/cancelar — Cancelar cita
router.post(
  '/:id/cancelar',
  authorize('citas', 'update'),
  validate({ params: citaIdParamsSchema, body: cancelarCitaSchema }),
  citasController.cancelar,
);

// POST /:id/no-asistio — Marcar no asistio
router.post(
  '/:id/no-asistio',
  authorize('citas', 'update'),
  validate({ params: citaIdParamsSchema }),
  citasController.noAsistio,
);

export default router;
