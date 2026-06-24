import { Router } from 'express';
import { authMiddleware, authorize, roleGuard } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { contratoIdParamsSchema } from './contratos.schema';
import { contratoTransitionBodySchema } from './contrato-workflow.schema';
import * as workflowController from './contrato-workflow.controller';

const router = Router();

// Todas las rutas de workflow requieren autenticacion
router.use(authMiddleware);

// POST /api/v1/contratos/:id/transitions — Ejecutar transicion.
// La inmobiliaria/propietario solo puede TERMINAR o CANCELAR su propio contrato
// (validado en el servicio: estado destino + ownership); el resto del workflow
// queda para roles internos. El gate fino vive en executeContratoTransition.
router.post(
  '/:id/transitions',
  roleGuard(['administrador', 'operador_analista', 'inmobiliaria', 'propietario']),
  validate({ params: contratoIdParamsSchema, body: contratoTransitionBodySchema }),
  workflowController.transition,
);

// POST /api/v1/contratos/:id/enviar-firma — Acción directa "Enviar a firma"
// (lleva a pendiente_firma + dispara el envío a Auco en un paso).
router.post(
  '/:id/enviar-firma',
  roleGuard(['administrador', 'operador_analista', 'inmobiliaria', 'propietario']),
  validate({ params: contratoIdParamsSchema }),
  workflowController.enviarFirma,
);

// GET /api/v1/contratos/:id/available-transitions — Transiciones disponibles
router.get(
  '/:id/available-transitions',
  authorize('contratos', 'read'),
  validate({ params: contratoIdParamsSchema }),
  workflowController.getAvailableTransitions,
);

// GET /api/v1/contratos/:id/transitions — Historial de transiciones
router.get(
  '/:id/transitions',
  authorize('contratos', 'read'),
  validate({ params: contratoIdParamsSchema }),
  workflowController.getHistory,
);

export default router;
