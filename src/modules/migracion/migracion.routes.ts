// ============================================================
// Migración de cartera — backoffice de Cofianza (spec §2.3.0: en la fase 1
// carga un analista; no hay autoservicio para la inmobiliaria).
// Montado en /api/v1/admin/migracion.
// ============================================================

import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { authMiddleware, roleGuard } from '@/middleware/auth';
import { validate } from '@/middleware/validate';
import { uploadPdf } from '@/middleware/upload';
import { AppError } from '@/lib/errors';
import * as controller from './migracion.controller';
import {
  auditoriaParams,
  auditoriaSchema,
  decisionAuditoriaSchema,
  exclusionSchema,
  filaParams,
  liquidacionQuery,
  listarLotesQuery,
  reportableSchema,
  reporteQuery,
  respuestaAuditoriaSchema,
  revisionSchema,
  tableroQuery,
  documentoHabilitacionParams,
  guardarHabilitacionSchema,
  habilitacionParams,
  loteParams,
  orgParams,
  procesarSchema,
  suspenderSchema,
  validarQuery,
} from './migracion.schema';

// §2.4.6: el límite real es MAX_FILAS_POR_CARGA; 5 MB sobra para ese número de filas.
const xlsxMulter = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith('.xlsx')) {
      cb(new AppError(400, 'INVALID_FILE_TYPE', 'Cargue la plantilla de Cofianza en formato Excel (.xlsx).'));
      return;
    }
    cb(null, true);
  },
}).single('archivo');

const uploadXlsx = (req: Request, res: Response, next: NextFunction) =>
  xlsxMulter(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE')
      return next(AppError.badRequest('El archivo supera 5 MB. Divídalo en varios lotes.', 'ARCHIVO_DEMASIADO_GRANDE'));
    next(err);
  });

const router = Router();
router.use(authMiddleware, roleGuard(['administrador', 'operador_analista']));

router.get('/plantilla', controller.descargarPlantilla);

router.get('/inmobiliarias/:inmobiliariaId', validate({ params: orgParams }), controller.estadoOrg);
router.put(
  '/inmobiliarias/:inmobiliariaId/habilitaciones/:destinacion',
  validate({ params: habilitacionParams, body: guardarHabilitacionSchema }),
  controller.guardarHabilitacion,
);
router.post(
  '/inmobiliarias/:inmobiliariaId/habilitaciones/:destinacion/documentos/:tipo',
  uploadPdf,
  validate({ params: documentoHabilitacionParams }),
  controller.cargarDocumento,
);
router.post(
  '/inmobiliarias/:inmobiliariaId/suspension',
  validate({ params: orgParams, body: suspenderSchema }),
  controller.suspender,
);
// Solo la Gerencia General (lo exige el servicio, 403).
router.delete('/inmobiliarias/:inmobiliariaId/suspension', validate({ params: orgParams }), controller.reactivar);

router.post(
  '/inmobiliarias/:inmobiliariaId/validar',
  uploadXlsx,
  validate({ params: orgParams, query: validarQuery }),
  controller.validar,
);
router.post(
  '/inmobiliarias/:inmobiliariaId/procesar',
  uploadXlsx,
  validate({ params: orgParams, body: procesarSchema }),
  controller.procesar,
);

// Acta de Migración (§3.3): envío a firma por Auco y estado.
router.post('/lotes/:loteId/acta/enviar', validate({ params: loteParams }), controller.enviarActa);
router.get('/lotes/:loteId/acta', validate({ params: loteParams }), controller.estadoActa);
router.post('/lotes/:loteId/acta/actualizar', validate({ params: loteParams }), controller.actualizarActa);
// Cancelación antes de la firma: anula el acta en Auco y libera los inmuebles del lote.
router.post('/lotes/:loteId/cancelar', validate({ params: loteParams }), controller.cancelarLote);

// Lotes y tablero (§8.1-§8.3); reportes §8.5 y liquidación mensual (§4.7).
router.get('/lotes', validate({ query: listarLotesQuery }), controller.listarLotes);
router.get('/lotes/:loteId/tablero', validate({ params: loteParams, query: tableroQuery }), controller.tablero);
router.get('/reportes/formato-anterior', validate({ query: reporteQuery }), controller.reporteSinPlantilla);
router.get('/reportes/liquidacion', validate({ query: liquidacionQuery }), controller.liquidacion);

// Cartera migrada: un contrato = una fila del lote (§5.1.3, §5.2.5, §6, §7).
router.get('/filas/:filaId', validate({ params: filaParams }), controller.detalleFila);
router.put('/filas/:filaId/revision', validate({ params: filaParams, body: revisionSchema }), controller.marcarRevision);
router.post('/filas/:filaId/exclusion', validate({ params: filaParams, body: exclusionSchema }), controller.excluir);
router.post('/filas/:filaId/reportable', validate({ params: filaParams, body: reportableSchema }), controller.pasarAReportable);
router.post('/filas/:filaId/auditorias', validate({ params: filaParams, body: auditoriaSchema }), controller.requerirAuditoria);
router.post(
  '/auditorias/:auditoriaId/respuesta',
  uploadPdf,
  validate({ params: auditoriaParams, body: respuestaAuditoriaSchema }),
  controller.responderAuditoria,
);
router.post(
  '/auditorias/:auditoriaId/decision',
  validate({ params: auditoriaParams, body: decisionAuditoriaSchema }),
  controller.decidirAuditoria,
);

export default router;
