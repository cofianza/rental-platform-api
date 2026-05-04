import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware, roleGuard } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { expedienteIdParamsSchema } from './expedientes.schema';
import * as controller from './expediente-habilitacion.controller';

const router = Router();

// PATCH /api/v1/expedientes/:id/habilitar-estudio — Paso 3 del flujo.
// roleGuard filtra solicitante/gerencia_consulta a nivel coarse-grained;
// el service aplica ownership fine-grained para propietario/inmobiliaria.
// El body recibe los datos del contrato que se persisten en el expediente
// para alimentar la generacion del contrato mas adelante (duracion + fecha
// de inicio). Ambos requeridos al habilitar.
router.patch(
  '/:id/habilitar-estudio',
  authMiddleware,
  roleGuard(['administrador', 'operador_analista', 'propietario', 'inmobiliaria']),
  validate({
    params: expedienteIdParamsSchema,
    body: z.object({
      duracion_contrato_meses: z.coerce.number().int().min(1).max(120),
      // YYYY-MM-DD; el frontend manda esto desde un <input type="date">.
      fecha_inicio_contrato: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato fecha invalido (YYYY-MM-DD)'),
    }),
  }),
  controller.habilitarEstudio,
);

// POST /api/v1/expedientes/:id/rechazar-estudio — Caso opuesto: el propietario
// decide tras la visita no proceder con el candidato. body.motivo es opcional
// y aparece en el aviso al solicitante.
router.post(
  '/:id/rechazar-estudio',
  authMiddleware,
  roleGuard(['administrador', 'operador_analista', 'propietario', 'inmobiliaria']),
  validate({
    params: expedienteIdParamsSchema,
    body: z.object({ motivo: z.string().max(2000).optional() }),
  }),
  controller.rechazarEstudio,
);

// POST /api/v1/expedientes/:id/aprobar-condicionado — Tras revisar la
// documentación adicional pedida (codeudor, póliza, etc.) el propietario
// decide proceder. Transicionamos expediente a 'aprobado' y disparamos la
// generación del contrato. No requiere body — todo se infiere del expediente.
router.post(
  '/:id/aprobar-condicionado',
  authMiddleware,
  roleGuard(['administrador', 'operador_analista', 'propietario', 'inmobiliaria']),
  validate({ params: expedienteIdParamsSchema }),
  controller.aprobarCondicionado,
);

export default router;
