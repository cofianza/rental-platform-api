import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { authMiddleware, authorize, roleGuard } from '@/middleware/auth';
import { expedienteIdParamsSchema } from '../contratos.schema';
import { autorizarExcesoSchema, guardarPasoSchema } from './asistente.schema';
import * as asistenteController from './asistente.controller';

// ============================================================
// Asistente de contratos V3: /api/v1/expedientes/:expedienteId/contrato-v3
// El service verifica el acceso al estudio (assertExpedienteAccess). Los
// miembros solo_lectura quedan fuera de PUT/POST por el middleware de auth.
// ============================================================

export const asistenteV3Router = Router({ mergeParams: true });
asistenteV3Router.use(authMiddleware);

// GET / — bloqueos, avisos, resumen y borrador (sin efectos).
asistenteV3Router.get(
  '/',
  roleGuard(['administrador', 'operador_analista', 'gerencia_consulta', 'inmobiliaria']),
  validate({ params: expedienteIdParamsSchema }),
  asistenteController.obtener,
);

// POST / — Iniciar: número, reserva del inmueble y aviso a los demás candidatos.
asistenteV3Router.post(
  '/',
  authorize('contratos', 'create'),
  validate({ params: expedienteIdParamsSchema }),
  asistenteController.iniciar,
);

// PUT /pasos — guarda un paso en el borrador.
asistenteV3Router.put(
  '/pasos',
  authorize('contratos', 'create'),
  validate({ params: expedienteIdParamsSchema, body: guardarPasoSchema }),
  asistenteController.guardarPaso,
);

// POST /generar — vista previa en modo revisión.
asistenteV3Router.post(
  '/generar',
  authorize('contratos', 'create'),
  validate({ params: expedienteIdParamsSchema }),
  asistenteController.generar,
);

// POST /clausulas/autorizar-exceso — un administrador autoriza el conjunto exacto
// de adicionales que supera el máximo (Entrega 4, D6).
asistenteV3Router.post(
  '/clausulas/autorizar-exceso',
  roleGuard(['administrador']),
  validate({ params: expedienteIdParamsSchema, body: autorizarExcesoSchema }),
  asistenteController.autorizarExceso,
);
