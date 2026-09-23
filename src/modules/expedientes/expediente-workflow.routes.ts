import { Router } from 'express';
import { authMiddleware, authorize, roleGuard } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { cerrarSinActaBodySchema, expedienteIdParamsSchema, transitionBodySchema } from './expediente-workflow.schema';
import * as workflowController from './expediente-workflow.controller';

const router = Router();

// Todas las rutas de workflow requieren autenticacion
router.use(authMiddleware);

// POST /api/v1/expedientes/:id/transitions — Ejecutar transicion.
// Admin/operador pueden hacer cualquier transicion. Propietario/inmobiliaria
// pueden hacer solo las transiciones terminales (aprobado/rechazado → cerrado)
// sobre expedientes de SUS inmuebles — el service hace el filtro fine-grained.
router.post(
  '/:id/transitions',
  roleGuard(['administrador', 'operador_analista', 'propietario', 'inmobiliaria']),
  validate({ params: expedienteIdParamsSchema, body: transitionBodySchema }),
  workflowController.transition,
);

// POST /api/v1/expedientes/:id/cerrar-sin-acta — Adenda 1 contratos (respuesta 21):
// solo un administrador cierra sin acta de entrega, con motivo registrado.
router.post(
  '/:id/cerrar-sin-acta',
  roleGuard(['administrador']),
  validate({ params: expedienteIdParamsSchema, body: cerrarSinActaBodySchema }),
  workflowController.cerrarSinActa,
);

// GET /api/v1/expedientes/:id/available-transitions — Transiciones disponibles
router.get(
  '/:id/available-transitions',
  authorize('expedientes', 'read'),
  validate({ params: expedienteIdParamsSchema }),
  workflowController.getAvailableTransitions,
);

// GET /api/v1/expedientes/:id/transitions — Historial de transiciones
router.get(
  '/:id/transitions',
  authorize('expedientes', 'read'),
  validate({ params: expedienteIdParamsSchema }),
  workflowController.getHistory,
);

export default router;
