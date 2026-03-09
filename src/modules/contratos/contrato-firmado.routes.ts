import { Router } from 'express';
import { authMiddleware, authorize, roleGuard } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { uploadPdf } from '@/middleware/upload';
import { contratoFirmadoParamsSchema, subirFirmadoBodySchema } from './contrato-firmado.schema';
import * as firmadoController from './contrato-firmado.controller';

const router = Router();

router.use(authMiddleware);

// POST /api/v1/contratos/:id/subir-firmado — Subir PDF firmado
router.post(
  '/:id/subir-firmado',
  roleGuard(['administrador', 'operador_analista']),
  uploadPdf,
  validate({ params: contratoFirmadoParamsSchema, body: subirFirmadoBodySchema }),
  firmadoController.subir,
);

// GET /api/v1/contratos/:id/descargar-firmado — Descargar PDF firmado (permisos custom)
router.get(
  '/:id/descargar-firmado',
  validate({ params: contratoFirmadoParamsSchema }),
  firmadoController.descargar,
);

// GET /api/v1/contratos/:id/info-firma — Metadatos de firma
router.get(
  '/:id/info-firma',
  authorize('contratos', 'read'),
  validate({ params: contratoFirmadoParamsSchema }),
  firmadoController.infoFirma,
);

// GET /api/v1/contratos/:id/verificar-integridad — Verificar integridad (solo admin)
router.get(
  '/:id/verificar-integridad',
  roleGuard(['administrador']),
  validate({ params: contratoFirmadoParamsSchema }),
  firmadoController.verificarIntegridad,
);

// GET /api/v1/contratos/:id/log-accesos — Historial de accesos (solo admin)
router.get(
  '/:id/log-accesos',
  roleGuard(['administrador']),
  validate({ params: contratoFirmadoParamsSchema }),
  firmadoController.logAccesos,
);

export default router;
