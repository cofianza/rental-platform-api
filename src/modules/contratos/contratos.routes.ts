import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { authMiddleware, authorize } from '@/middleware/auth';
import {
  contratoIdParamsSchema,
  expedienteIdParamsSchema,
  generarContratoSchema,
  renovarContratoSchema,
  regenerarContratoSchema,
  listContratosQuerySchema,
  listAllContratosQuerySchema,
  versionDescargarParamsSchema,
  compararVersionesQuerySchema,
} from './contratos.schema';
import * as contratosController from './contratos.controller';

// ============================================================
// Expediente-scoped routes: /api/v1/expedientes/:expedienteId/contratos
// ============================================================

export const expedienteContratosRouter = Router({ mergeParams: true });
expedienteContratosRouter.use(authMiddleware);

// GET / — List contratos for expediente
expedienteContratosRouter.get(
  '/',
  authorize('contratos', 'read'),
  validate({ params: expedienteIdParamsSchema, query: listContratosQuerySchema }),
  contratosController.listByExpediente,
);

// POST /generar — Generate contract from template
expedienteContratosRouter.post(
  '/generar',
  authorize('contratos', 'create'),
  validate({ params: expedienteIdParamsSchema, body: generarContratoSchema }),
  contratosController.generar,
);

// ============================================================
// Standalone routes: /api/v1/contratos
// ============================================================

export const contratosRouter = Router();
contratosRouter.use(authMiddleware);

// GET / — List all contratos (global)
contratosRouter.get(
  '/',
  authorize('contratos', 'read'),
  validate({ query: listAllContratosQuerySchema }),
  contratosController.listAll,
);

// GET /:id — Get contract detail
contratosRouter.get(
  '/:id',
  authorize('contratos', 'read'),
  validate({ params: contratoIdParamsSchema }),
  contratosController.getDetalle,
);

// POST /:id/renovar — Create renewal contract (vigente only)
contratosRouter.post(
  '/:id/renovar',
  authorize('contratos', 'create'),
  validate({ params: contratoIdParamsSchema, body: renovarContratoSchema }),
  contratosController.renovar,
);

// POST /:id/regenerar — Regenerate PDF (draft only)
contratosRouter.post(
  '/:id/regenerar',
  authorize('contratos', 'update'),
  validate({ params: contratoIdParamsSchema, body: regenerarContratoSchema }),
  contratosController.regenerar,
);

// GET /:id/versiones — List archived versions
contratosRouter.get(
  '/:id/versiones',
  authorize('contratos', 'read'),
  validate({ params: contratoIdParamsSchema }),
  contratosController.listVersiones,
);

// GET /:id/versiones/comparar — Compare two versions (BEFORE :versionNum catch-all)
contratosRouter.get(
  '/:id/versiones/comparar',
  authorize('contratos', 'read'),
  validate({ params: contratoIdParamsSchema, query: compararVersionesQuerySchema }),
  contratosController.compararVersiones,
);

// GET /:id/versiones/:versionNum/descargar — Download specific version PDF
contratosRouter.get(
  '/:id/versiones/:versionNum/descargar',
  authorize('contratos', 'read'),
  validate({ params: versionDescargarParamsSchema }),
  contratosController.descargarVersion,
);

// GET /:id/descargar — Download current PDF (signed URL)
contratosRouter.get(
  '/:id/descargar',
  authorize('contratos', 'read'),
  validate({ params: contratoIdParamsSchema }),
  contratosController.descargar,
);
