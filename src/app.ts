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
import usersRouter from '@/modules/users/users.routes';
import registrationRouter from '@/modules/registration/registration.routes';
import { bitacoraRouter } from '@/modules/bitacora/bitacora.routes';
import inmueblesRouter from '@/modules/inmuebles/inmuebles.routes';
import applicantsRouter from '@/modules/solicitantes/solicitantes.routes';

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
app.use('/api/v1/users', usersRouter);
app.use('/api/v1/inmuebles', inmueblesRouter);
app.use('/api/v1/audit-logs', bitacoraRouter);
app.use('/api/v1/applicants', applicantsRouter);

// Error handler (must be last)
app.use(errorHandler);

export default app;
