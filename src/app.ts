import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env } from '@/config';
import { logger } from '@/lib/logger';
import { errorHandler } from '@/middleware/errorHandler';
import { generalLimiter } from '@/middleware/rateLimiter';
import healthRouter from '@/modules/health/health.routes';
import authRouter from '@/modules/auth/auth.routes';
import expedientesRouter from '@/modules/expedientes/expedientes.routes';
import expedienteWorkflowRouter from '@/modules/expedientes/expediente-workflow.routes';
import expedienteCommentsRouter from '@/modules/expedientes/expediente-comments.routes';
import expedienteTimelineRouter from '@/modules/expedientes/expediente-timeline.routes';
import expedienteAssignmentsRouter from '@/modules/expedientes/expediente-assignments.routes';
import usersRouter from '@/modules/users/users.routes';
import registrationRouter from '@/modules/registration/registration.routes';
import { bitacoraRouter } from '@/modules/bitacora/bitacora.routes';
import inmueblesRouter from '@/modules/inmuebles/inmuebles.routes';
import applicantsRouter from '@/modules/solicitantes/solicitantes.routes';
import documentosRouter from '@/modules/documentos/documentos.routes';
import expedienteDocumentosRouter from '@/modules/documentos/expediente-documentos.routes';
import tiposDocumentoRouter from '@/modules/documentos/tipos-documento.routes';
import adminTiposDocumentoRouter from '@/modules/documentos/admin-tipos-documento.routes';
import { expedienteEstudiosRouter, estudiosRouter, publicEstudiosRouter, proveedoresRiesgoRouter, publicVerificarRouter } from '@/modules/estudios/estudios.routes';
import { expedienteAutorizacionRouter, publicAutorizacionRouter } from '@/modules/autorizaciones/autorizaciones.routes';
import plantillasRouter from '@/modules/plantillas/plantillas.routes';
import { expedienteContratosRouter, contratosRouter } from '@/modules/contratos/contratos.routes';
import contratoWorkflowRouter from '@/modules/contratos/contrato-workflow.routes';

const app = express();

// Security
app.use(helmet());
app.use(
  cors({
    origin: env.CORS_ORIGIN,
    credentials: true,
  }),
);

// Rate limiting
app.use(generalLimiter);

// Logging with request ID tracing
app.use(
  pinoHttp({
    logger,
    genReqId: (req) => {
      const existing = req.headers['x-request-id'];
      return typeof existing === 'string' ? existing : crypto.randomUUID();
    },
  }),
);

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api/v1/health', healthRouter);
app.use('/api/v1/auth/register', registrationRouter);
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/expedientes', expedientesRouter);
app.use('/api/v1/expedientes', expedienteWorkflowRouter);
app.use('/api/v1/expedientes', expedienteCommentsRouter);
app.use('/api/v1/expedientes', expedienteTimelineRouter);
app.use('/api/v1/expedientes', expedienteAssignmentsRouter);
app.use('/api/v1/users', usersRouter);
app.use('/api/v1/inmuebles', inmueblesRouter);
app.use('/api/v1/audit-logs', bitacoraRouter);
app.use('/api/v1/applicants', applicantsRouter);
app.use('/api/v1/documentos', documentosRouter);
app.use('/api/v1/expedientes', expedienteDocumentosRouter);
app.use('/api/v1/tipos-documento', tiposDocumentoRouter);
app.use('/api/v1/admin/tipos-documento', adminTiposDocumentoRouter);
app.use('/api/v1/expedientes/:expedienteId/estudios', expedienteEstudiosRouter);
app.use('/api/v1/estudios', estudiosRouter);
app.use('/api/v1/public/estudios', publicEstudiosRouter);
app.use('/api/v1/public/verificar', publicVerificarRouter);
app.use('/api/v1/proveedores-riesgo', proveedoresRiesgoRouter);
app.use('/api/v1/expedientes/:expedienteId/autorizacion-riesgo', expedienteAutorizacionRouter);
app.use('/api/v1/public/autorizar', publicAutorizacionRouter);
app.use('/api/v1/plantillas-contrato', plantillasRouter);
app.use('/api/v1/expedientes/:expedienteId/contratos', expedienteContratosRouter);
app.use('/api/v1/contratos', contratoWorkflowRouter);
app.use('/api/v1/contratos', contratosRouter);

// Error handler (must be last)
app.use(errorHandler);

export default app;
