import { Router } from 'express';
import { authMiddleware, roleGuard } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { expedienteIdParamsSchema } from './expedientes.schema';
import * as controller from './expediente-habilitacion.controller';

const router = Router();

// PATCH /api/v1/expedientes/:id/habilitar-estudio — Paso 3 del flujo.
// roleGuard filtra solicitante/gerencia_consulta a nivel coarse-grained;
// el service aplica ownership fine-grained para propietario/inmobiliaria.
router.patch(
  '/:id/habilitar-estudio',
  authMiddleware,
  roleGuard(['administrador', 'operador_analista', 'propietario', 'inmobiliaria']),
  validate({ params: expedienteIdParamsSchema }),
  controller.habilitarEstudio,
);

export default router;
